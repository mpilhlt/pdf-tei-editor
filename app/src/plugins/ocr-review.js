/**
 * Tools action "Find OCR errors (LLM)": reviews the open TEI document page window by page window
 * with an LLM through the backend and shows the suggested corrections as diagnostics, each with a
 * "Propose fix" action that opens the merge view. In focus mode, the "OCR auto-corrections" button
 * reviews the pages of the focused node without asking (the review of the whole document asks for
 * confirmation). Once that review found errors, the button of the node becomes "Write text
 * corrections to PDF", which writes the corrections on these pages into the PDF without creating a
 * new version (see TextCorrectionsPlugin#writePages); afterwards the node gets "OCR
 * auto-corrections" again. The corrections of the whole document are written to the PDF with
 * Tools > Write text corrections to PDF (see text-corrections.js). Each accepted correction
 * is recorded in the document history (`teiHeader/revisionDesc`) by the user, naming the model that
 * suggested it; the corrections accepted one after another share one change. This covers fixes
 * accepted in the merge view ("Propose fix") and fixes applied in the diagnostics drawer.
 *
 * Requires the line layout of the document (`GET /api/v1/files/{stable_id}/layout`), which only
 * zone documents with a layout provider have.
 *
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { SlMenuItem } from '../ui.js'
 * @import { Finding } from '../modules/llm-findings.js'
 * @import { OcrCorrectionsRecord } from '../modules/tei-utils.js'
 * @import { MergeViewHideEventData } from '../modules/xmleditor.js'
 * @import { FixableDiagnostic } from '../modules/lint-utils.js'
 * @import { FocusAction } from '../modules/codemirror/focus-mode.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { notify } from '../modules/sl-utils.js'
import { testLog } from '../modules/test-log.js'
import { FindingsDisplay, buildModifiedText } from '../modules/llm-findings.js'
import { SessionStorage } from '../modules/session-storage.js'
import * as lintUtils from '../modules/lint-utils.js'
import { getRevisionStatus, recordOcrCorrections } from '../modules/tei-utils.js'
import { prettyPrintXmlDom } from '../modules/xml-utils.js'

/** Diagnostic source tag identifying this plugin's diagnostics */
const SOURCE = 'ocr-review'

/** Tooltip of the menu item */
const TOOLTIP = 'The language model suggests corrections in the TEI document, which you review one by one. The PDF is not changed: use "Write text corrections to PDF" afterwards.'

/** Added to the tooltip when the document has no layout */
const NO_DOCUMENT_MESSAGE = 'Requires an open TEI document with a line layout.'

/**
 * Escape text for use in the dialog's HTML message.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

class OcrReviewPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'ocr-review', deps: ['client', 'tools'] })
  }

  get #client() { return this.getDependency('client') }

  /** @type {SlMenuItem|null} */
  #menuItem = null

  /** @type {FindingsDisplay|null} */
  #display = null

  /** Why the open document cannot be reviewed (no layout); null if it can */
  #layoutMissing = /** @type {string|null} */ (null)

  /** True once the layout of the open document is known to be there */
  #layoutOk = false

  /** True while a review runs */
  #busy = false

  /**
   * The fix shown in the merge view: the document it was proposed for, its text before and the
   * model that suggested it. `shown` is set once the merge view shows it.
   * @type {{stableId: string, before: string, model: string|null, shown: boolean}|null}
   */
  #pendingFix = null

  /**
   * Per document (stable_id): the revision change that records the corrections accepted in this
   * session, which later corrections update while it is the last change.
   * @type {Map<string, OcrCorrectionsRecord>}
   */
  #recorded = new Map()

  /** Button shown on the focused node in the XML editor's focus mode */
  #focusAction = {
    label: 'OCR auto-corrections',
    title: 'Find OCR errors in the pages of this node',
    run: () => { this.run().catch(error => this.#fail(error)) }
  }

  /** Button shown instead on a node whose pages were reviewed and not yet written to the PDF */
  #writeAction = {
    label: 'Write text corrections to PDF',
    title: 'Write the corrections on the pages of this node into the text layer of the PDF',
    run: () => { this.#writeUnit().catch(error => this.#failWrite(error)) }
  }

  /** The write button, disabled while the corrections are written */
  #writeActionBusy = { ...this.#writeAction, disabled: true, title: 'The corrections are being written to the PDF' }

  /**
   * Per document (stable_id): the nodes (XPath) whose pages a review found errors in and whose
   * corrections have not been written to the PDF yet, with these pages (0-based).
   * @type {Map<string, Map<string, number[]>>}
   */
  #unwrittenUnits = new Map()

  /** True while the corrections of a node are written */
  #writing = false

  async start() {
    const item = /** @type {SlMenuItem} */ (document.createElement('sl-menu-item'))
    item.textContent = 'Find OCR errors (LLM)'
    item.disabled = true
    item.addEventListener('click', () => {
      this.run({ wholeDocument: true }).catch(error => this.#fail(error))
    })
    this.#menuItem = item
    this.getDependency('tools').addMenuItems([item], 'ocr')

    const xmlEditor = this.getDependency('xmleditor')
    this.#display = new FindingsDisplay({
      source: SOURCE,
      getXmleditor: () => this.getDependency('xmleditor'),
      getLintUtils: () => lintUtils,
      sessionStorage: new SessionStorage(SOURCE),
      proposeFix: (finding, from, to) => this.#proposeFix(finding, from, to),
      getDocId: () => this.state?.xml || null
    })
    this.#display.attach()
    this.#display.restore(this.state?.xml || null)
    xmlEditor.on('editorReady', () => this.#updateMenuState())
    xmlEditor.on('editorHideMergeView', (/** @type {MergeViewHideEventData} */ data) => this.#onMergeViewHidden(data))
    lintUtils.addFixListener(fixed => this.#onFixesApplied(fixed))
    this.#updateMenuState()
    await this.#checkLayout()
  }

  /**
   * A different document is loaded: keep the findings of the previous one in the session cache and
   * restore those of the new one.
   * @param {string|null} [_doc]
   */
  async onXmlChange(_doc) {
    this.#writing = false
    this.#display?.switchDocument(this.state?.xml || null)
    this.#layoutOk = false
    this.#layoutMissing = null
    this.#updateMenuState()
    await this.#checkLayout()
  }

  /**
   * Find out whether the open document has a line layout and update the menu item.
   * @returns {Promise<void>}
   */
  async #checkLayout() {
    const stableId = this.state?.xml || null
    let ok = false
    let missing = null
    if (stableId) {
      try {
        const layout = await this.#client.apiClient.filesGetLayout(stableId)
        ok = layout.status === 'ok'
        if (!ok) missing = layout.message || 'The layout information of this document is missing.'
      } catch (error) {
        missing = `The page layout could not be loaded: ${/** @type {Error} */ (error)?.message ?? String(error)}`
      }
    }
    if (this.state?.xml !== stableId) return
    this.#layoutOk = ok
    this.#layoutMissing = missing
    this.#updateMenuState()
  }

  /**
   * The focused node changed: show the button that fits it.
   * @param {string|null} [_xpath]
   */
  onXpathChange(_xpath) {
    this.#updateMenuState()
  }

  /** Button shown, disabled, while a review runs */
  #focusActionBusy = { ...this.#focusAction, disabled: true, title: 'An OCR review is running' }

  /**
   * The pages of the focused node if a review found errors on them that have not been written to
   * the PDF yet.
   * @returns {number[]|null}
   */
  #unwrittenPages() {
    const stableId = this.state?.xml
    const xpath = this.state?.xpath
    if (!stableId || !xpath) return null
    return this.#unwrittenUnits.get(stableId)?.get(xpath) ?? null
  }

  /**
   * The button of the focused node: "Write text corrections to PDF" if its pages were reviewed
   * and not written yet, otherwise "OCR auto-corrections"; disabled while a review or a write runs.
   * @returns {FocusAction}
   */
  #currentFocusAction() {
    if (this.#writing) return this.#writeActionBusy
    if (this.#busy) return this.#focusActionBusy
    return this.#unwrittenPages() ? this.#writeAction : this.#focusAction
  }

  /**
   * Enable the menu item and the focus action when a document with a layout is open; while a
   * review runs, both are disabled.
   */
  #updateMenuState() {
    if (!this.#menuItem) return
    const enabled = Boolean(this.state?.xml) && this.#layoutOk
    this.#menuItem.disabled = !enabled || this.#busy
    this.#menuItem.title = enabled ? TOOLTIP : `${TOOLTIP} ${this.#layoutMissing ?? NO_DOCUMENT_MESSAGE}`
    try {
      this.getDependency('xmleditor').setFocusAction(SOURCE, enabled ? this.#currentFocusAction() : null)
    } catch {
      // the editor is not ready yet: editorReady calls again
    }
  }

  /**
   * Write the corrections on the pages of the focused node into the PDF. Afterwards, or if there
   * is nothing to write, the node gets the "OCR auto-corrections" button again.
   * @returns {Promise<void>}
   */
  async #writeUnit() {
    const stableId = this.state?.xml
    const xpath = this.state?.xpath
    const pages = this.#unwrittenPages()
    if (!stableId || !xpath || !pages || this.#writing) return
    this.#writing = true
    this.#updateMenuState()
    try {
      const status = await this.getDependency('text-corrections').writePages(pages)
      if (status !== 'failed') this.#unwrittenUnits.get(stableId)?.delete(xpath)
      testLog('OCR_UNIT_WRITE_DONE', { stableId, xpath, pages, status })
    } finally {
      this.#writing = false
      this.#updateMenuState()
    }
  }

  /**
   * Show an error of writing the corrections of a node.
   * @param {any} error
   */
  #failWrite(error) {
    const lines = error?.detail?.lines
    let message = error?.message ?? String(error)
    if (Array.isArray(lines) && lines.length) message += ` (lines: ${lines.join(', ')})`
    notify(`Writing the text corrections failed: ${message}`, 'danger', 'exclamation-octagon', 10000)
    testLog('TEXT_CORRECTIONS_FAILED', { message })
  }

  /**
   * Open the merge view showing only the given finding's change.
   * @param {Finding} finding
   * @param {number} from
   * @param {number} to
   * @returns {Promise<void>}
   */
  async #proposeFix(finding, from, to) {
    const xmlEditor = this.getDependency('xmleditor')
    const modified = buildModifiedText(xmlEditor.getView().state.doc.toString(), from, to, finding)
    if (modified === null) {
      notify('The document changed; this finding no longer applies.', 'warning', 'exclamation-triangle')
      return
    }
    const pending = { stableId: this.state?.xml || '', before: xmlEditor.getView().state.doc.toString(), model: finding.model ?? null, shown: false }
    this.#pendingFix = pending
    try {
      await xmlEditor.showMergeView(modified)
      pending.shown = true
    } catch (error) {
      if (this.#pendingFix === pending) this.#pendingFix = null
      notify(`Could not show the proposed fix: ${/** @type {Error} */ (error).message}`, 'danger', 'exclamation-octagon')
    }
  }

  /**
   * The merge view was closed. If it showed a fix of this plugin and the document changed, the fix
   * was accepted (wholly or in part): record it in the document history.
   * @param {MergeViewHideEventData} data
   */
  #onMergeViewHidden(data) {
    const pending = this.#pendingFix
    // a merge view replaced while showing the fix is that of another plugin or another fix
    if (!pending?.shown) return
    this.#pendingFix = null
    if (data?.replaced) return
    const xmlEditor = this.getDependency('xmleditor')
    if (this.state?.xml !== pending.stableId || xmlEditor.getView().state.doc.toString() === pending.before) return
    this.#recordAcceptedFixes(pending.stableId, [pending.model])
  }

  /**
   * Fixes of diagnostics were applied without the merge view (diagnostics drawer): record those of
   * this plugin. Called before the fixes are dispatched; the recording waits for the editor sync.
   * @param {FixableDiagnostic[]} fixed
   */
  #onFixesApplied(fixed) {
    const own = fixed.filter(d => d.source === SOURCE)
    const stableId = this.state?.xml
    if (!own.length || !stableId || !this.#display) return
    const findings = this.#display.findings
    const models = own.map(d => findings.find(f => f.rationale === d.message && f.new === d.replacement)?.model ?? null)
    this.#recordAcceptedFixes(stableId, models)
  }

  /**
   * Record accepted OCR corrections in the revision history of the open document, notifying the
   * user if that fails.
   * @param {string} stableId - The document the corrections were accepted in
   * @param {(string|null)[]} models - Per correction, the name of the model that suggested it
   */
  #recordAcceptedFixes(stableId, models) {
    // one at a time, so that each sees the change of the previous one
    this.#recording = this.#recording.then(() => this.#recordFixes(stableId, models)).catch(error => {
      notify(`The OCR correction could not be recorded in the document history: ${/** @type {Error} */ (error)?.message ?? String(error)}`, 'warning', 'exclamation-triangle')
    })
  }

  /** The recording in progress */
  #recording = Promise.resolve()

  /**
   * Record accepted OCR corrections in the revision history of the open document.
   * @param {string} stableId - The document the corrections were accepted in
   * @param {(string|null)[]} models - Per correction, the name of the model that suggested it
   * @returns {Promise<void>}
   */
  async #recordFixes(stableId, models) {
    const xmlEditor = this.getDependency('xmleditor')
    await xmlEditor.syncIfChanged()
    if (this.state?.xml !== stableId) return
    const xmlDoc = xmlEditor.getXmlTree()
    if (!xmlDoc || !xmlEditor.isSynced()) {
      throw new Error('the XML in the editor is not well-formed')
    }
    const user = this.state?.user
    if (!user) throw new Error('no user is logged in')
    const record = recordOcrCorrections(xmlDoc, {
      persId: user.username,
      fullName: user.fullname,
      status: getRevisionStatus(xmlDoc) || 'draft',
      count: models.length,
      models,
      previous: this.#recorded.get(stableId) ?? null
    })
    this.#recorded.set(stableId, record)
    prettyPrintXmlDom(xmlDoc, 'teiHeader')
    await xmlEditor.updateEditorFromXmlTree()
    testLog('OCR_CORRECTION_RECORDED', { stableId, count: record.count, when: record.when })
  }

  /**
   * Confirm with the model's name, then review the document page window by page window behind a
   * cancellable progress widget. The findings are shown as each window completes, so that a
   * failing or cancelled run keeps those found so far.
   * @param {{wholeDocument?: boolean}} [options] wholeDocument reviews the whole document even
   *   while node navigation has selected a node (the Tools menu item)
   * @returns {Promise<void>}
   */
  async run(options = {}) {
    const stableId = this.state?.xml
    if (!stableId || !this.#display) return
    if (this.#busy) {
      notify('An OCR review is already running.', 'primary', 'info-circle')
      return
    }
    const inferenceSettings = this.getDependency('inference-settings')
    const model = inferenceSettings.getDefaultModel()
    if (!model) {
      notify('No default model configured. Set one via Tools > Inference > Default Model.', 'warning', 'exclamation-triangle')
      return
    }
    const xpath = options.wholeDocument ? null : (this.state?.xpath || null)
    const label = inferenceSettings.getModelLabel(model.providerId, model.modelId)
    // only the review of the whole document asks; the pages of a node are reviewed right away
    if (!xpath) {
      const confirmed = await this.getDependency('dialog').confirm(
        `Find OCR errors in the document using ${escapeHtml(label)}? The text of the pages is sent to the model.`,
        'Find OCR errors'
      )
      if (!confirmed) return
    }

    const xmlEditor = this.getDependency('xmleditor')
    const xml = xmlEditor.getView().state.doc.toString()
    /** @type {{scope?: string}} */
    const scoped = {}
    if (xpath) {
      try {
        const { from, to } = xmlEditor.getRangeByXpath(xpath)
        scoped.scope = xml.slice(from, to)
      } catch (error) {
        notify(`Cannot review the selected node: ${/** @type {Error} */ (error).message}`, 'warning', 'exclamation-triangle')
        return
      }
    }

    const progress = this.getDependency('progress')
    const progressId = 'ocr-review'
    const heading = `Finding OCR errors using ${label}…`
    const documentChanged = () => this.state?.xml !== stableId
    let cancelled = false
    let windowsDone = 0
    let total = 0
    let count = 0
    /** @type {number[]} */
    let pages = []
    this.#busy = true
    this.#updateMenuState()
    progress.show(progressId, { title: 'Finding OCR errors', label: heading, value: null, cancellable: true, onCancel: () => { cancelled = true } })
    try {
      try {
        const plan = await this.#client.apiClient.ocrLlmReviewPlan({ stable_id: stableId, xml, ...scoped })
        total = plan.window_count
        pages = plan.pages ?? []
      } catch (error) {
        this.#fail(error)
        return
      }
      for (let index = 0; index < total; index++) {
        if (cancelled || documentChanged()) break
        progress.setValue(progressId, Math.round((index / total) * 100))
        progress.setLabel(progressId, `${heading} (page window ${index + 1} of ${total})`)
        /** @type {Finding[]} */
        let found
        try {
          const response = await this.#client.apiClient.ocrLlmReview({
            stable_id: stableId, xml, ...scoped, provider_id: model.providerId, model_id: model.modelId, window_index: index
          })
          total = response.window_count ?? total
          found = response.findings
        } catch (error) {
          if (!documentChanged()) {
            const reason = /** @type {Error} */ (error)?.message ?? String(error)
            notify(`Finding OCR errors failed in page window ${index + 1} of ${total}: ${reason}. ${count} possible error(s) found before.`, 'danger', 'exclamation-octagon', 10000)
            testLog('OCR_REVIEW_FAILED', { window: index + 1, message: reason, findings: count })
          }
          return
        }
        windowsDone = index + 1
        // findings of another document must not attach to the one now open
        if (documentChanged()) return
        // the findings of the previous review are replaced by those of this one
        if (index === 0) this.#display.clear()
        // appended, so that findings dismissed or applied meanwhile do not come back; the drawer
        // opens for the first findings only
        // the model is kept with each finding, for the document history when the fix is accepted
        if (found.length) count += this.#display.append(found.map(f => ({ ...f, model: label })), count === 0)
      }
      if (documentChanged()) return
      if (cancelled) {
        notify(`Review cancelled after ${windowsDone} of ${total} page windows; ${count} possible OCR error(s) so far.`, 'warning', 'exclamation-triangle')
        return
      }
      // the node gets the button that writes its corrections
      if (xpath && count && pages.length) {
        if (!this.#unwrittenUnits.has(stableId)) this.#unwrittenUnits.set(stableId, new Map())
        this.#unwrittenUnits.get(stableId)?.set(xpath, pages)
      }
      const writeHint = xpath ? 'click "Write text corrections to PDF"' : 'use Tools > Write text corrections to PDF'
      notify(
        count
          ? `Found ${count} possible OCR error${count === 1 ? '' : 's'}. Accept the ones you agree with, then ${writeHint}.`
          : 'No OCR errors found.',
        count ? 'primary' : 'success',
        count ? 'info-circle' : 'check-circle'
      )
      testLog('OCR_REVIEW_DONE', { findings: count, windows: windowsDone })
    } finally {
      this.#busy = false
      this.#updateMenuState()
      progress.hide(progressId)
    }
  }

  /**
   * Show an error of a request.
   * @param {any} error
   */
  #fail(error) {
    const message = error?.message ?? String(error)
    notify(`Finding OCR errors failed: ${message}`, 'danger', 'exclamation-octagon', 10000)
    testLog('OCR_REVIEW_FAILED', { message })
  }
}

export default OcrReviewPlugin
export { OcrReviewPlugin }
