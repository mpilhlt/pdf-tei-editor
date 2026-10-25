/**
 * Diagnostics Drawer Plugin
 *
 * Lists the XML editor's diagnostics (validation errors, annotation review
 * suggestions, ...) in a drawer on the left side, over the PDF viewer,
 * instead of CodeMirror's lint panel below the editor. The drawer is shown
 * while there are diagnostics. It slides out while the focus is in the PDF
 * viewer, leaving a floating "Diagnostics" button with the count. Focusing the
 * XML editor does not expand it again (so that the XML can be edited while the
 * whole PDF is visible); it is expanded when a document is loaded, when the
 * floating button is clicked, when a diagnostics source asks for it (see
 * `applyMergedDiagnostics()` in lint-utils.js) and when a statusbar widget of
 * the XML editor marked with the `data-reveals-diagnostics` attribute (e.g.
 * the unit review and comment meters) is clicked.
 *
 * Clicking a diagnostic selects the text it applies to in the editor. Each
 * diagnostic shows its actions (e.g. "Propose fix") as buttons. The footer
 * applies the fixes (`replacement`, see lint-utils.js) of, or dismisses, the
 * checked diagnostics; both switch off the merge view first.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlDrawer, SlCheckbox } from '../ui.js'
 * @import { ViewUpdate } from '@codemirror/view'
 * @import { FixableDiagnostic } from '../modules/lint-utils.js'
 * @import { diagnosticsDrawerPart, diagnosticsButtonPart } from '../templates/diagnostics-drawer.types.js'
 */

import { EditorView } from '@codemirror/view'
import { Plugin } from '../modules/plugin-base.js'
import ui, { registerTemplate, createFromTemplate } from '../ui.js'
import { notify } from '../modules/sl-utils.js'
import { linkifyNodes } from '../modules/linkify.js'
import {
  collectDiagnostics,
  diagnosticKey,
  dismissDiagnostics,
  fixChanges,
  replacesDiagnostics,
  revealsDiagnostics
} from '../modules/lint-utils.js'

/**
 * A diagnostic as listed in the drawer
 * @typedef {object} DiagnosticEntry
 * @property {FixableDiagnostic} diagnostic - With positions in the current editor state
 * @property {string} key - See {@link diagnosticKey}
 * @property {number} line - 1-based line of the diagnostic's start
 */

/** @type {Record<string, number>} Order of severities in the list, most severe first */
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2, hint: 3 }

/** Delay before the list is refreshed after the diagnostics changed */
const REFRESH_DELAY_MS = 100

await registerTemplate('diagnostics-drawer', 'diagnostics-drawer.html')

class DiagnosticsDrawerPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'diagnostics-drawer', deps: ['xmleditor', 'pdfviewer'] })
  }

  get #xmlEditor() { return this.getDependency('xmleditor') }

  /** @type {SlDrawer & diagnosticsDrawerPart} */
  #ui = null

  /** @type {HTMLButtonElement & diagnosticsButtonPart} Shown instead of the retracted drawer */
  #button = null

  /** @type {DiagnosticEntry[]} */
  #entries = []

  /** @type {Set<string>} Keys of the checked diagnostics */
  #checked = new Set()

  /** @type {string|null} Key of the diagnostic last clicked */
  #selectedKey = null

  /** True while the drawer is fully shown, false while retracted */
  #expanded = true

  #refreshScheduled = false

  /**
   * @param {ApplicationState} state
   */
  async install(state) {
    await super.install(state)
    this.getDependency('logger').debug(`Installing plugin "${this.name}"`)

    // the wrapper around the PDF pages, so that the drawer leaves the PDF toolbars visible
    const parent = this.getDependency('pdfviewer').viewerWrapper
    const [drawer, button] = createFromTemplate('diagnostics-drawer', parent)
      .filter(node => node instanceof HTMLElement)
    this.#ui = this.createUi(/** @type {SlDrawer} */ (drawer))
    this.#button = this.createUi(/** @type {HTMLButtonElement} */ (button))

    // the drawer stays open; its visibility is controlled by the `empty` class
    this.#ui.addEventListener('sl-initial-focus', event => event.preventDefault())
    this.#ui.addEventListener('sl-request-close', event => event.preventDefault())
    this.#ui.open = true

    this.#button.addEventListener('click', () => this.#setExpanded(true))

    // focus in the PDF viewer retracts the drawer; focus in the XML editor does not expand it
    for (const type of ['focusin', 'pointerdown']) {
      ui.pdfViewer.addEventListener(type, event => {
        const target = /** @type {Node} */ (event.target)
        if (!this.#ui.contains(target) && !this.#button.contains(target)) this.#setExpanded(false)
      })
    }

    // statusbar widgets related to the diagnostics expand the drawer when clicked
    ui.xmlEditor.statusbar.addEventListener('click', event => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-reveals-diagnostics]')) this.#setExpanded(true)
    })

    this.#ui.footer.selectAll.addEventListener('sl-change', () => {
      const checked = this.#ui.footer.selectAll.checked
      this.#checked = checked ? new Set(this.#entries.map(e => e.key)) : new Set()
      this.#render()
    })
    this.#ui.footer.applyBtn.addEventListener('click', () => this.applyChecked())
    this.#ui.footer.dismissBtn.addEventListener('click', () => this.dismissChecked())

    this.#xmlEditor.addUpdateListener(update => this.#onEditorUpdate(update))
  }

  /**
   * @param {(keyof ApplicationState)[]} changedKeys
   * @param {ApplicationState} state
   */
  async onStateUpdate(changedKeys, state) {
    if (changedKeys.includes('xml')) {
      this.#checked.clear()
      // a newly loaded document shows its diagnostics
      if (state.xml) this.#setExpanded(true)
    }
    if (changedKeys.includes('editorReadOnly')) this.#updateFooter()
  }

  //
  // Public API
  //

  /**
   * Applies the fixes of the checked diagnostics without confirmation and
   * removes these diagnostics. Checked diagnostics without a fix are kept.
   * Switches off the merge view first.
   * @returns {Promise<void>}
   */
  async applyChecked() {
    if (this.state?.editorReadOnly) return
    await this.#switchOffMergeView()
    await this.#pendingRemerges()
    const view = this.#xmlEditor.getView()
    const checked = this.#checkedDiagnostics(view)
    const { changes, applied } = fixChanges(checked)
    // test each fix on its own: a transaction filter (e.g. the annotator edit guard)
    // rejects a whole transaction if any of its changes touches protected text
    const accepted = applied.filter((_d, i) => {
      const tr = view.state.update({ changes: changes[i], userEvent: 'input' })
      return tr.docChanged && tr.newDoc.sliceString(changes[i].from, changes[i].from + changes[i].insert.length) === changes[i].insert
    })
    if (accepted.length) {
      // dismiss first, while the diagnostics still cover the text they are keyed by
      for (const d of accepted) this.#checked.delete(diagnosticKey(view.state, d))
      dismissDiagnostics(view, accepted)
      view.dispatch({ changes: changes.filter((_c, i) => accepted.includes(applied[i])), userEvent: 'input' })
    }
    const rejected = applied.length - accepted.length
    if (rejected) {
      notify(`${rejected} fix(es) could not be applied because they change protected text.`, 'warning', 'exclamation-triangle')
    }
    const kept = checked.length - applied.length
    if (kept) {
      notify(`${kept} selected diagnostic(s) have no applicable fix and were kept.`, 'warning', 'exclamation-triangle')
    }
    this.#scheduleRefresh()
  }

  /**
   * Removes the checked diagnostics. Switches off the merge view first.
   * @returns {Promise<void>}
   */
  async dismissChecked() {
    await this.#switchOffMergeView()
    await this.#pendingRemerges()
    const view = this.#xmlEditor.getView()
    dismissDiagnostics(view, this.#checkedDiagnostics(view))
    this.#checked.clear()
    this.#scheduleRefresh()
  }

  /**
   * Whether the drawer is fully shown (true) or retracted (false)
   * @returns {boolean}
   */
  isExpanded() {
    return this.#expanded
  }

  //
  // Private methods
  //

  /**
   * @param {ViewUpdate} update
   */
  #onEditorUpdate(update) {
    if (revealsDiagnostics(update)) this.#setExpanded(true)
    if (update.docChanged || replacesDiagnostics(update)) this.#scheduleRefresh()
  }

  /**
   * @param {boolean} expanded
   */
  #setExpanded(expanded) {
    if (this.#expanded === expanded) return
    this.#expanded = expanded
    this.#ui.classList.toggle('retracted', !expanded)
    this.#updateButton()
  }

  /**
   * Shows the floating button while the drawer is retracted and has diagnostics
   */
  #updateButton() {
    this.#button.hidden = this.#expanded || this.#entries.length === 0
  }

  /**
   * Refreshes the list after a short delay, once for several updates. A source replacing the
   * diagnostic set (e.g. a validation run) removes those of other sources, which merge theirs in
   * again right after (unit review, unit comments, LLM review): refreshing in between would empty
   * the list for a moment and make it flicker.
   */
  #scheduleRefresh() {
    if (this.#refreshScheduled) return
    this.#refreshScheduled = true
    setTimeout(() => {
      this.#refreshScheduled = false
      this.#refresh()
    }, REFRESH_DELAY_MS)
  }

  /**
   * Re-reads the diagnostics from the editor state and re-renders the list
   */
  #refresh() {
    const state = this.#xmlEditor.getView().state
    this.#entries = collectDiagnostics(state)
      .map(diagnostic => ({
        diagnostic,
        key: diagnosticKey(state, diagnostic),
        line: state.doc.lineAt(diagnostic.from).number
      }))
      .sort((a, b) => a.diagnostic.from - b.diagnostic.from
        || SEVERITY_ORDER[a.diagnostic.severity] - SEVERITY_ORDER[b.diagnostic.severity])
    // checks are kept for diagnostics that are not listed: replacing the diagnostic set (e.g. a
    // validation run) removes the diagnostics of other sources until they re-merge them
    this.#render()
  }

  /**
   * Renders the list, header and footer from the current entries
   */
  #render() {
    const empty = this.#entries.length === 0
    this.#ui.classList.toggle('empty', empty)
    const variant = this.#entries.some(e => e.diagnostic.severity === 'error') ? 'danger'
      : this.#entries.some(e => e.diagnostic.severity === 'warning') ? 'warning' : 'neutral'
    for (const count of [this.#ui.header.count, this.#button.count]) {
      count.textContent = String(this.#entries.length)
      count.setAttribute('variant', variant)
    }
    this.#updateButton()
    this.#ui.list.replaceChildren(...this.#entries.map(entry => this.#renderEntry(entry)))
    this.#updateFooter()
  }

  /**
   * Creates the list item for one diagnostic, styled like CodeMirror's lint panel entries
   * @param {DiagnosticEntry} entry
   * @returns {HTMLElement}
   */
  #renderEntry(entry) {
    const { diagnostic, key } = entry
    const item = document.createElement('div')
    item.className = `diagnostics-drawer-item diagnostics-drawer-${diagnostic.severity}`
    item.classList.toggle('selected', key === this.#selectedKey)
    item.setAttribute('role', 'listitem')
    item.title = 'Show in the XML editor'

    const checkbox = /** @type {SlCheckbox} */ (document.createElement('sl-checkbox'))
    checkbox.size = 'small'
    checkbox.checked = this.#checked.has(key)
    checkbox.title = ''
    checkbox.addEventListener('click', event => event.stopPropagation())
    checkbox.addEventListener('sl-change', () => {
      if (checkbox.checked) this.#checked.add(key)
      else this.#checked.delete(key)
      this.#updateFooter()
    })

    const body = document.createElement('div')
    body.className = 'diagnostics-drawer-item-body'
    const message = document.createElement('span')
    message.className = 'diagnostics-drawer-message'
    message.replaceChildren(...linkifyNodes(diagnostic.message))
    body.append(message)

    // source on the left, actions on the right
    const meta = document.createElement('div')
    meta.className = 'diagnostics-drawer-meta'
    const info = document.createElement('span')
    info.className = 'diagnostics-drawer-source'
    info.textContent = [`Line ${entry.line}`, diagnostic.source].filter(Boolean).join(' · ')
    meta.append(info)

    for (const action of diagnostic.actions ?? []) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'diagnostics-drawer-action'
      button.textContent = action.name
      button.addEventListener('click', event => {
        event.stopPropagation()
        const current = this.#findCurrent(key)
        if (!current) return
        action.apply(this.#xmlEditor.getView(), current.from, current.to)
      })
      meta.append(button)
    }
    body.append(meta)

    item.append(checkbox, body)
    item.addEventListener('click', () => this.#showInEditor(key))
    return item
  }

  /**
   * Enables the footer controls according to the checked diagnostics
   */
  #updateFooter() {
    const { selectAll, applyBtn, dismissBtn } = this.#ui.footer
    const count = this.#entries.filter(e => this.#checked.has(e.key)).length
    selectAll.checked = count > 0 && count === this.#entries.length
    selectAll.indeterminate = count > 0 && count < this.#entries.length
    selectAll.disabled = this.#entries.length === 0
    const fixable = this.#entries.some(e => this.#checked.has(e.key) && typeof e.diagnostic.replacement === 'string')
    applyBtn.disabled = !fixable || Boolean(this.state?.editorReadOnly)
    dismissBtn.disabled = count === 0
  }

  /**
   * Selects the text of the diagnostic with the given key and scrolls it into view
   * @param {string} key
   */
  #showInEditor(key) {
    const current = this.#findCurrent(key)
    if (!current) return
    this.#selectedKey = key
    for (const [index, item] of Array.from(this.#ui.list.children).entries()) {
      item.classList.toggle('selected', this.#entries[index]?.key === key)
    }
    const view = this.#xmlEditor.getView()
    view.dispatch({
      selection: { anchor: current.from, head: current.to },
      effects: EditorView.scrollIntoView(current.from, { y: 'center' })
    })
    view.focus()
  }

  /**
   * Returns the diagnostic with the given key as currently stored in the editor
   * @param {string} key
   * @returns {FixableDiagnostic|undefined}
   */
  #findCurrent(key) {
    const state = this.#xmlEditor.getView().state
    return collectDiagnostics(state).find(d => diagnosticKey(state, d) === key)
  }

  /**
   * Returns the checked diagnostics as currently stored in the editor
   * @param {EditorView} view
   * @returns {FixableDiagnostic[]}
   */
  #checkedDiagnostics(view) {
    return collectDiagnostics(view.state).filter(d => this.#checked.has(diagnosticKey(view.state, d)))
  }

  /**
   * Hides the merge view if it is shown, keeping the current document
   * @returns {Promise<void>}
   */
  async #switchOffMergeView() {
    if (this.#xmlEditor.isMergeViewActive()) {
      await this.getDependency('services').removeMergeView()
    }
  }

  /**
   * Waits for the plugins to re-merge their diagnostics after the diagnostic set was replaced
   * (e.g. by a validation run), which they defer with `setTimeout`: until then, their checked
   * diagnostics are missing from the editor state
   * @returns {Promise<void>}
   */
  #pendingRemerges() {
    return new Promise(resolve => setTimeout(resolve, 0))
  }
}

export default DiagnosticsDrawerPlugin
