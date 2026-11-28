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
 * When diagnostics are added (by a validation run, an LLM review, ...), the list scrolls to show
 * them. Added diagnostics that have a fix (e.g. LLM review suggestions) are checked, so that they
 * can be applied right away (#688); added diagnostics without a fix (validation errors, comments,
 * disputed reviews) are not checked, and the checks of the other diagnostics are left as they are. Diagnostics that reappear
 * (e.g. after a re-validation) and those whose text was edited count as known, not as added.
 *
 * Clicking a diagnostic selects the text it applies to in the editor. Each
 * diagnostic shows its actions (e.g. "Propose fix") as buttons, and diagnostics with a fix an
 * "Apply fix" button that applies only that fix. The footer
 * applies the fixes (`replacement`, see lint-utils.js) of, or dismisses, the
 * checked diagnostics; both switch off the merge view first.
 *
 * The diagnostics of sync sources (`registerSyncSource()` in lint-utils.js: differences between the
 * text and data derived from the PDF, e.g. GROBID's feature file) are listed in their own section,
 * "Differences from the PDF", below the others. Their fix undoes the change ("Revert to PDF text"),
 * so they are never checked automatically and "Select all" leaves them out: applying the checked
 * fixes must not revert intended corrections along with the fixes that improve the document. The
 * section has a button for writing the changes into the PDF if a plugin provides it
 * ({@link DiagnosticsDrawerPlugin#setSyncAction}, see sync-prompt.js).
 *
 * {@link DiagnosticsDrawerPlugin#showSources} lists only the diagnostics of some sources (e.g. the
 * sync diagnostics, see sync-prompt.js), with a button in the header that removes the filter. The
 * filter is also removed when a document is loaded and when no diagnostic of these sources is left.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlDrawer, SlCheckbox } from '../ui.js'
 * @import { ViewUpdate } from '@codemirror/view'
 * @import { FixableDiagnostic, SyncDiagnostic } from '../modules/lint-utils.js'
 * @import { diagnosticsDrawerPart, diagnosticsButtonPart } from '../templates/diagnostics-drawer.types.js'
 */

import { EditorView } from '@codemirror/view'
import { Plugin } from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import ui, { registerTemplate, createFromTemplate } from '../ui.js'
import { notify } from '../modules/sl-utils.js'
import { linkifyNodes } from '../modules/linkify.js'
import { userHasRole } from '../modules/acl-utils.js'
import {
  collectDiagnostics,
  deleteDiagnostics,
  diagnosticKey,
  dismissDiagnostics,
  fixChanges,
  notifyFixesApplied,
  replacesDiagnostics,
  revealsDiagnostics,
  syncSourceOptions
} from '../modules/lint-utils.js'

/**
 * A diagnostic as listed in the drawer
 * @typedef {object} DiagnosticEntry
 * @property {FixableDiagnostic} diagnostic - With positions in the current editor state
 * @property {string} key - See {@link diagnosticKey}
 * @property {number} line - 1-based line of the diagnostic's start
 * @property {boolean} sync - Whether it is a diagnostic of a sync source, listed in its own section
 */

/**
 * The button of the "Differences from the PDF" section (see {@link DiagnosticsDrawerPlugin#setSyncAction})
 * @typedef {object} SyncAction
 * @property {string} label - Text of the button
 * @property {string} title - Its tooltip
 * @property {(diagnostics: SyncDiagnostic[]) => (void|Promise<void>)} run - Called with the listed sync diagnostics
 */

/** Label of the fix button of sync diagnostics, whose fix undoes a change of the text */
export const REVERT_FIX_LABEL = 'Revert to PDF text'

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

  /** @type {Set<string>} Keys of the diagnostics listed since the document was loaded */
  #knownKeys = new Set()

  /** @type {{from: number, to: number}[]} Ranges of the current document edited since the last refresh */
  #editedRanges = []

  /** @type {Set<string>|null} Sources whose diagnostics are listed, null for all */
  #sourceFilter = null

  /** @type {SyncAction|null} */
  #syncAction = null

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

    // statusbar widgets related to the diagnostics expand the drawer when clicked, if there are any
    ui.xmlEditor.statusbar.addEventListener('click', event => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-reveals-diagnostics]') && this.#entries.length > 0) {
        this.#setExpanded(true)
      }
    })

    // sync diagnostics are only checked one by one
    this.#ui.footer.selectAll.addEventListener('sl-change', () => {
      const checked = this.#ui.footer.selectAll.checked
      this.#checked = checked ? new Set([...this.#checked, ...this.#entries.filter(e => !e.sync).map(e => e.key)]) : new Set()
      this.#render()
    })
    this.#ui.syncGroup.syncAction.addEventListener('click', () => this.#runSyncAction())
    this.#ui.header.filterButton.addEventListener('click', () => this.showSources(null))
    this.#ui.footer.applyBtn.addEventListener('click', () => this.applyChecked())
    this.#ui.footer.dismissBtn.addEventListener('click', () => this.dismissChecked())
    this.#ui.footer.deleteBtn.addEventListener('click', () => this.deleteChecked())

    this.#xmlEditor.addUpdateListener(update => this.#onEditorUpdate(update))
  }

  /**
   * @param {(keyof ApplicationState)[]} changedKeys
   * @param {ApplicationState} state
   */
  async onStateUpdate(changedKeys, state) {
    if (changedKeys.includes('xml')) {
      this.#checked.clear()
      this.#knownKeys.clear()
      this.#setSourceFilter(null, '')
      // a newly loaded document shows its diagnostics
      if (state.xml) this.#setExpanded(true)
    }
    if (changedKeys.includes('editorReadOnly')) this.#render()
    else if (changedKeys.includes('user')) this.#updateFooter()
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
    const applied = this.#applyFixes(view, checked)
    const kept = checked.length - applied
    if (kept) {
      notify(`${kept} selected diagnostic(s) have no applicable fix and were kept.`, 'warning', 'exclamation-triangle')
    }
    this.#scheduleRefresh()
  }

  /**
   * Applies the fix of the diagnostic with the given key (see {@link diagnosticKey}) without
   * confirmation and removes the diagnostic, leaving the checks of the others as they are.
   * Switches off the merge view first.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async applyFix(key) {
    if (this.state?.editorReadOnly) return
    await this.#switchOffMergeView()
    await this.#pendingRemerges()
    const view = this.#xmlEditor.getView()
    const diagnostic = collectDiagnostics(view.state).find(d => diagnosticKey(view.state, d) === key)
    if (!diagnostic) return
    this.#applyFixes(view, [diagnostic])
    this.#scheduleRefresh()
  }

  /**
   * Removes the checked diagnostics and the data behind them: the plugins that own them (unit
   * review, unit comments) delete the review marks and comment threads they show. Diagnostics
   * without such data are dismissed. Only for reviewers and admins, in documents they can edit.
   * Switches off the merge view first.
   * @returns {Promise<void>}
   */
  async deleteChecked() {
    if (!this.#canDelete()) return
    await this.#switchOffMergeView()
    await this.#pendingRemerges()
    const view = this.#xmlEditor.getView()
    deleteDiagnostics(view, this.#checkedDiagnostics(view))
    this.#checked.clear()
    this.#scheduleRefresh()
  }

  /**
   * Applies the fixes of the given diagnostics and removes the diagnostics whose fix was applied.
   * Warns about fixes that change protected text.
   * @param {EditorView} view
   * @param {FixableDiagnostic[]} diagnostics - With positions in the current editor state
   * @returns {number} The number of diagnostics with a fix, applied or not
   */
  #applyFixes(view, diagnostics) {
    const { changes, applied } = fixChanges(diagnostics)
    // test each fix on its own: a transaction filter (e.g. the annotator edit guard)
    // rejects a whole transaction if any of its changes touches protected text
    const accepted = applied.filter((_d, i) => {
      const tr = view.state.update({ changes: changes[i], userEvent: 'input' })
      return tr.docChanged && tr.newDoc.sliceString(changes[i].from, changes[i].from + changes[i].insert.length) === changes[i].insert
    })
    if (accepted.length) {
      notifyFixesApplied(accepted)
      // dismiss first, while the diagnostics still cover the text they are keyed by
      for (const d of accepted) this.#checked.delete(diagnosticKey(view.state, d))
      dismissDiagnostics(view, accepted)
      view.dispatch({ changes: changes.filter((_c, i) => accepted.includes(applied[i])), userEvent: 'input' })
    }
    const rejected = applied.length - accepted.length
    if (rejected) {
      notify(`${rejected} fix(es) could not be applied because they change protected text.`, 'warning', 'exclamation-triangle')
    }
    return applied.length
  }

  /**
   * Whether the current user may delete diagnostics with their data.
   * @returns {boolean}
   */
  #canDelete() {
    return userHasRole(this.state?.user ?? null, ['reviewer', 'admin']) && !this.state?.editorReadOnly
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
   * Lists only the diagnostics of the given sources and expands the drawer, or lists all again.
   * The header shows `label` in a button that lists all diagnostics again.
   * @param {string[]|null} sources - null lists all diagnostics
   * @param {string} [label] - Name of the listed diagnostics, e.g. "Sync changes"
   * @returns {void}
   */
  showSources(sources, label = 'Filtered') {
    this.#setSourceFilter(sources, label)
    this.#refresh()
    if (sources) this.#setExpanded(true)
  }

  /**
   * Sets the button of the "Differences from the PDF" section, which is hidden without one.
   * @param {SyncAction|null} action
   * @returns {void}
   */
  setSyncAction(action) {
    this.#syncAction = action
    this.#render()
  }

  /**
   * The sources whose diagnostics are listed, or null if all are listed.
   * @returns {string[]|null}
   */
  getSourceFilter() {
    return this.#sourceFilter ? [...this.#sourceFilter] : null
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
    if (update.docChanged) this.#addEditedRanges(update)
    if (update.docChanged || replacesDiagnostics(update)) this.#scheduleRefresh()
  }

  /**
   * Sets the source filter and its button in the header, without refreshing the list.
   * @param {string[]|null} sources
   * @param {string} label
   */
  #setSourceFilter(sources, label) {
    this.#sourceFilter = sources ? new Set(sources) : null
    const button = this.#ui.header.filterButton
    button.filterLabel.textContent = label
    button.hidden = !sources
  }

  /** Runs the action of the sync section with the listed sync diagnostics. */
  async #runSyncAction() {
    const action = this.#syncAction
    if (!action || this.state?.editorReadOnly) return
    const diagnostics = this.#entries.filter(e => e.sync).map(e => /** @type {SyncDiagnostic} */ (e.diagnostic))
    await action.run(diagnostics)
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
    const all = collectDiagnostics(state)
    const filter = this.#sourceFilter
    // the filter ends with the last of its diagnostics (fixed, dismissed or edited away)
    if (filter && !all.some(d => filter.has(d.source ?? ''))) this.#setSourceFilter(null, '')
    this.#entries = all
      .filter(d => !this.#sourceFilter || this.#sourceFilter.has(d.source ?? ''))
      .map(diagnostic => ({
        diagnostic,
        key: diagnosticKey(state, diagnostic),
        line: state.doc.lineAt(diagnostic.from).number,
        sync: syncSourceOptions(diagnostic.source) !== null
      }))
      // in the order of the list: the other diagnostics, then those of the sync section
      .sort((a, b) => Number(a.sync) - Number(b.sync)
        || a.diagnostic.from - b.diagnostic.from
        || SEVERITY_ORDER[a.diagnostic.severity] - SEVERITY_ORDER[b.diagnostic.severity])
    const added = this.#takeAddedKeys()
    // otherwise, checks are kept for diagnostics that are not listed: replacing the diagnostic set
    // (e.g. a validation run) removes the diagnostics of other sources until they re-merge them
    // not sync diagnostics: their fix reverts a change that may be intended
    const fixable = this.#entries
      .filter(e => added.has(e.key) && !e.sync && typeof e.diagnostic.replacement === 'string')
      .map(e => e.key)
    // added to the checks, so that the suggestions of all parts of a chunked LLM review stay checked
    for (const key of fixable) this.#checked.add(key)
    this.#render()
    if (added.size) this.#scrollToEntries(added)
  }

  /**
   * Remembers the ranges an update changed, mapping those remembered before to the new document.
   * @param {ViewUpdate} update
   */
  #addEditedRanges(update) {
    const ranges = this.#editedRanges.map(({ from, to }) => ({
      from: update.changes.mapPos(from, -1),
      to: update.changes.mapPos(to, 1)
    }))
    update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => ranges.push({ from: fromB, to: toB }))
    this.#editedRanges = ranges
  }

  /**
   * Returns the keys of the listed diagnostics that were not listed before since the document was
   * loaded, and remembers all listed keys. A diagnostic whose text was edited since the last
   * refresh has a new key: it counts as known. Edits elsewhere (e.g. review marks written to the
   * standOff along with LLM review suggestions) do not matter.
   * @returns {Set<string>}
   */
  #takeAddedKeys() {
    const edited = this.#editedRanges
    this.#editedRanges = []
    const added = new Set()
    for (const { key, diagnostic } of this.#entries) {
      if (this.#knownKeys.has(key)) continue
      this.#knownKeys.add(key)
      if (!edited.some(range => range.from <= diagnostic.to && range.to >= diagnostic.from)) added.add(key)
    }
    return added
  }

  /**
   * Scrolls the drawer body (only the drawer, not the PDF viewer around it) so that the entries
   * with the given keys are visible below the sticky header, from the first one on if they do not
   * fit.
   * @param {Set<string>} keys
   */
  #scrollToEntries(keys) {
    const body = /** @type {HTMLElement|null|undefined} */ (this.#ui.shadowRoot?.querySelector('[part~="body"]'))
    const items = this.#items().filter(item => keys.has(item.dataset.key ?? ''))
    const first = items[0]
    const last = items[items.length - 1]
    if (!body || !first || !last) return
    // positions in the scrolled content
    const origin = body.getBoundingClientRect().top - body.scrollTop
    const top = first.getBoundingClientRect().top - origin
    const bottom = last.getBoundingClientRect().bottom - origin
    const header = this.#ui.header.offsetHeight
    const visible = body.clientHeight - header
    if (bottom - top > visible || top < body.scrollTop + header) {
      body.scrollTop = Math.max(0, top - header)
    } else if (bottom > body.scrollTop + body.clientHeight) {
      body.scrollTop = bottom - body.clientHeight
    }
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
    this.#ui.list.replaceChildren(...this.#entries.filter(e => !e.sync).map(entry => this.#renderEntry(entry)))
    const sync = this.#entries.filter(e => e.sync)
    const { syncGroup } = this.#ui
    syncGroup.hidden = sync.length === 0
    syncGroup.syncList.replaceChildren(...sync.map(entry => this.#renderEntry(entry)))
    const action = this.#syncAction
    syncGroup.syncAction.hidden = !action
    syncGroup.syncAction.textContent = action?.label ?? ''
    syncGroup.syncAction.title = action?.title ?? ''
    syncGroup.syncAction.disabled = Boolean(this.state?.editorReadOnly)
    this.#updateFooter()
  }

  /**
   * The list items of the entries, in the order of the entries
   * @returns {HTMLElement[]}
   */
  #items() {
    return /** @type {HTMLElement[]} */ ([...this.#ui.list.children, ...this.#ui.syncGroup.syncList.children])
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
    // lets a source style its entries' stripe (e.g. unit review states, see app.css)
    if (diagnostic.markClass) item.classList.add(...diagnostic.markClass.split(/\s+/).filter(Boolean))
    item.classList.toggle('selected', key === this.#selectedKey)
    item.dataset.key = key
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
    // one-click alternative to checking the diagnostic and clicking Apply
    if (typeof diagnostic.replacement === 'string') {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'diagnostics-drawer-action diagnostics-drawer-apply-fix'
      button.textContent = entry.sync ? REVERT_FIX_LABEL : 'Apply fix'
      button.title = entry.sync ? 'Undo this change: restore the text the PDF has here' : 'Apply this fix without confirmation'
      button.disabled = Boolean(this.state?.editorReadOnly)
      button.addEventListener('click', event => {
        event.stopPropagation()
        this.applyFix(key)
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
    const { selectAll, applyBtn, dismissBtn, deleteBtn } = this.#ui.footer
    const count = this.#entries.filter(e => this.#checked.has(e.key)).length
    // "Select all" checks all but the sync diagnostics
    const selectable = this.#entries.filter(e => !e.sync)
    const selected = selectable.filter(e => this.#checked.has(e.key)).length
    selectAll.checked = selected > 0 && selected === selectable.length
    selectAll.indeterminate = count > 0 && !selectAll.checked
    selectAll.disabled = selectable.length === 0
    const fixable = this.#entries.some(e => this.#checked.has(e.key) && typeof e.diagnostic.replacement === 'string')
    applyBtn.disabled = !fixable || Boolean(this.state?.editorReadOnly)
    dismissBtn.disabled = count === 0
    // not `hidden`, which the button's own display style overrides
    deleteBtn.style.display = userHasRole(this.state?.user ?? null, ['reviewer', 'admin']) ? '' : 'none'
    deleteBtn.disabled = count === 0 || !this.#canDelete()
  }

  /**
   * Selects the text of the diagnostic with the given key and scrolls it into view
   * @param {string} key
   */
  #showInEditor(key) {
    const current = this.#findCurrent(key)
    if (!current) return
    this.#selectedKey = key
    for (const item of this.#items()) item.classList.toggle('selected', item.dataset.key === key)
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
    if (!this.#xmlEditor.isMergeViewActive()) return
    await this.context.invokePluginEndpoint(ep.mergeView.hide, [], { throws: true })
    // a merge view shown without the merge-view plugin (e.g. directly by a backend plugin extension)
    await this.#xmlEditor.hideMergeView()
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
