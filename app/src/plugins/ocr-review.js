/**
 * Tools action "Find OCR errors (LLM)": reviews the open TEI document page window by page window
 * with an LLM through the backend and shows the suggested corrections as diagnostics, each with a
 * "Propose fix" action that opens the merge view. In focus mode, the "LLM OCR review" button
 * reviews the pages of the focused node. The corrections the reviewer accepts are written to the
 * PDF with Tools > Write text corrections to PDF (see text-corrections.js).
 *
 * Requires the line layout of the document (`GET /api/v1/files/{stable_id}/layout`), which only
 * zone documents with a layout provider have.
 *
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { SlMenuItem } from '../ui.js'
 * @import { Finding } from '../modules/llm-findings.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { notify } from '../modules/sl-utils.js'
import { testLog } from '../modules/test-log.js'
import { FindingsDisplay, buildModifiedText } from '../modules/llm-findings.js'
import { SessionStorage } from '../modules/session-storage.js'
import * as lintUtils from '../modules/lint-utils.js'

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

  /** Button shown on the focused node in the XML editor's focus mode */
  #focusAction = {
    label: 'LLM OCR review',
    title: 'Find OCR errors in the pages of this node',
    run: () => { this.run().catch(error => this.#fail(error)) }
  }

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
    this.#updateMenuState()
    await this.#checkLayout()
  }

  /**
   * A different document is loaded: keep the findings of the previous one in the session cache and
   * restore those of the new one.
   * @param {string|null} [_doc]
   */
  async onXmlChange(_doc) {
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

  /** Enable the menu item and the focus action when a document with a layout is open. */
  #updateMenuState() {
    if (!this.#menuItem) return
    const enabled = Boolean(this.state?.xml) && this.#layoutOk
    this.#menuItem.disabled = !enabled
    this.#menuItem.title = enabled ? TOOLTIP : `${TOOLTIP} ${this.#layoutMissing ?? NO_DOCUMENT_MESSAGE}`
    try {
      this.getDependency('xmleditor').setFocusAction(SOURCE, enabled ? this.#focusAction : null)
    } catch {
      // the editor is not ready yet: editorReady calls again
    }
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
    try {
      await xmlEditor.showMergeView(modified)
    } catch (error) {
      notify(`Could not show the proposed fix: ${/** @type {Error} */ (error).message}`, 'danger', 'exclamation-octagon')
    }
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
    const what = xpath ? 'the pages of the selected node' : 'the document'
    const confirmed = await this.getDependency('dialog').confirm(
      `Find OCR errors in ${what} using ${escapeHtml(label)}? The text of the pages is sent to the model.`,
      'Find OCR errors'
    )
    if (!confirmed) return

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
    this.#busy = true
    progress.show(progressId, { title: 'Finding OCR errors', label: heading, value: null, cancellable: true, onCancel: () => { cancelled = true } })
    try {
      try {
        ({ window_count: total } = await this.#client.apiClient.ocrLlmReviewPlan({ stable_id: stableId, xml, ...scoped }))
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
        if (found.length) count += this.#display.append(found, count === 0)
      }
      if (documentChanged()) return
      if (cancelled) {
        notify(`Review cancelled after ${windowsDone} of ${total} page windows; ${count} possible OCR error(s) so far.`, 'warning', 'exclamation-triangle')
        return
      }
      notify(
        count
          ? `Found ${count} possible OCR error${count === 1 ? '' : 's'}. Accept the ones you agree with, then use Tools > Write text corrections to PDF.`
          : 'No OCR errors found.',
        count ? 'primary' : 'success',
        count ? 'info-circle' : 'check-circle'
      )
      testLog('OCR_REVIEW_DONE', { findings: count, windows: windowsDone })
    } finally {
      this.#busy = false
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
