/**
 * Unit Review Plugin
 *
 * Lets reviewers mark the review units of a document (e.g. each `<bibl>`) as OK or not OK, shows
 * the combined result of all reviewers as a status strip left of the XML editor's line numbers,
 * and stores the marks stand-off in `TEI/standOff/listAnnotation[@type="unit-review"]`.
 * See docs/history/2026-10-23-unit-review-marking.md for the design and
 * docs/user-manual/unit-review.md for the user documentation.
 *
 * The marks are part of the document text: marking a unit edits the `standOff` element, so undo,
 * saving and versions work as for any other edit.
 *
 * Other plugins (e.g. the LLM Reviewer) record reviews with {@link UnitReviewPlugin#setMarks} and
 * read the units with {@link UnitReviewPlugin#getUnits}.
 *
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { EditorView, BlockInfo, ViewUpdate } from '@codemirror/view'
 * @import { ChangeSet, EditorState } from '@codemirror/state'
 * @import { SyntaxNode } from '@lezer/common'
 * @import { Diagnostic } from '@codemirror/lint'
 * @import { Unit, UnitScan, ReviewData, CombinedUnit, ReviewSummary, MarkState, Mark, Reviewer } from '../modules/unit-review.js'
 * @import { LineMark, LineMarkState } from '../modules/codemirror/unit-review-gutter.js'
 * @import { PopoverReview } from '../modules/unit-review-popover.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import { keymap } from '@codemirror/view'
import { Prec, Transaction } from '@codemirror/state'
import { syntaxTree, foldInside, foldedRanges, foldEffect } from '@codemirror/language'
import { PanelUtils } from '../modules/panels/index.js'
import { notify } from '../modules/sl-utils.js'
import { userHasRole } from '../modules/acl-utils.js'
import { testLog } from '../modules/test-log.js'
import * as tei_utils from '../modules/tei-utils.js'
import { prettyPrintXmlDom } from '../modules/xml-utils.js'
import { applyMergedDiagnostics, collectDiagnostics, replacesDiagnostics } from '../modules/lint-utils.js'
import {
  LIST_TYPE, DEFAULT_UNIT_PATH, findUnits, readReviewData, serializeReviewData, combineReviews,
  setMark, reconcileReviewData, emptyReviewData
} from '../modules/unit-review.js'
import { unitReviewGutter, buildUnitReviewMarkers, setUnitReviewMarkersEffect } from '../modules/codemirror/unit-review-gutter.js'
import { openReviewPopover, openCommentPrompt, closePopover, formatWhen } from '../modules/unit-review-popover.js'

/** Diagnostic source tag of this plugin's diagnostics */
const SOURCE = 'unit-review'

/** Source tag of the LLM Reviewer's diagnostics (pte-plugins annotation-review) */
const LLM_REVIEW_SOURCE = 'annotation-review'

const TEI_NS = 'http://www.tei-c.org/ns/1.0'

/** Delay after the last edit before units are recomputed */
const REFRESH_DELAY_MS = 250

/**
 * A mark set through {@link UnitReviewPlugin#setMarks}
 * @typedef {object} ExternalMark
 * @property {string} fingerprint
 * @property {MarkState|null} state - null removes the reviewer's mark
 * @property {string} [comment]
 */

/**
 * A reviewer setting marks through {@link UnitReviewPlugin#setMarks}
 * @typedef {object} ExternalReviewer
 * @property {string} id - e.g. `llm-kisski-llama-3.3`; ids starting with `llm-` are LLM reviewers
 * @property {string} [name] - Display name, e.g. `KISSKI / Llama 3.3`
 */

class UnitReviewPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'unit-review', deps: ['xmleditor', 'logger'] })
  }

  get #xmlEditor() { return this.getDependency('xmleditor') }
  get #logger() { return this.getDependency('logger') }

  /** @type {{ reconfigure: (ext: any) => void }|null} */
  #slot = null

  /** Review mode: strip, shortcuts and menu entries are active */
  #enabled = false

  /** @type {any} */
  #toggle = null

  /** @type {HTMLElement|null} */
  #meter = null

  /** @type {'majority'|'final'} */
  #mode = 'majority'

  #llmVote = true

  /** @type {Record<string, string>} Unit path by variant id, from the extractors */
  #variantPaths = {}

  /** @type {UnitScan} */
  #scan = { units: [], looseText: [], complete: true, path: null }

  /** The unit path used for the current scan */
  #unitPath = DEFAULT_UNIT_PATH

  /** @type {ReviewData} */
  #data = emptyReviewData()

  /** @type {Map<string, CombinedUnit>} */
  #combined = new Map()

  /** @type {ReviewSummary} */
  #summary = { units: 0, ok: 0, notOk: 0, disputed: 0, open: 0 }

  /** Fingerprint cache by raw unit text */
  #fpCache = new Map()

  /** @type {ChangeSet|null} Document changes since the last scan */
  #pendingChanges = null

  /** @type {Map<string, string>} Original fingerprint by fingerprint of a unit edited in this session */
  #carry = new Map()

  /** @type {ReturnType<typeof setTimeout>|undefined} */
  #timer = undefined

  /** @type {string} Key of the diagnostics last applied, to avoid redundant dispatches */
  #diagnosticsKey = ''

  /** @type {{startLine: number, endLine: number, notOk: boolean}|null} */
  #drag = null

  #writing = false

  /** @param {ApplicationState} state */
  async install(state) {
    await super.install(state)
    this.#slot = this.#xmlEditor.createExtensionSlot([])

    this.#toggle = PanelUtils.createToggleButton({
      name: 'unitReviewToggle',
      icon: 'clipboard-check',
      tooltip: 'Review: mark units as OK or not OK'
    })
    this.#toggle.addEventListener('widget-change', () => this.setEnabled(Boolean(this.#toggle.checked)))
    this.#xmlEditor.addToolbarWidget(this.#toggle, 93)

    this.#meter = this.#createMeter()
    this.#xmlEditor.addStatusbarWidget(this.#meter, 'right', 4)

    this.#xmlEditor.addUpdateListener(update => this.#onEditorUpdate(update))
    this.#xmlEditor.on('editorAfterLoad', () => this.#onDocumentLoaded())
    document.addEventListener('mouseup', () => this.#endDrag())
  }

  async start() {
    await this.#loadConfig()
    if (this.uiStorage.get('enabled') === true) await this.setEnabled(true)
    this.#refresh()
  }

  static extensionPoints = [ep.xmlEditor.contextMenuItems];

  /**
   * Extension point handler for `ep.xmlEditor.contextMenuItems`.
   * Called by the XmlEditorPlugin during start() to collect context menu contributions.
   * Delegates to {@link UnitReviewPlugin#getContextMenuItems}.
   * @returns {Array<{element: HTMLElement, onBeforeShow?: (ctx: {readOnly: boolean}) => void}>}
   */
  [ep.xmlEditor.contextMenuItems]() { return this.getContextMenuItems() }

  /**
   * @param {ApplicationState|null} newUser
   */
  async onUserChange(newUser) {
    if (newUser) await this.#loadConfig()
    this.#refresh()
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Switches review mode on or off.
   * @param {boolean} enabled
   */
  async setEnabled(enabled) {
    this.#enabled = enabled
    if (this.#toggle) this.#toggle.checked = enabled
    this.uiStorage.set('enabled', enabled)
    this.#slot?.reconfigure(enabled ? this.#extensions() : [])
    if (!enabled) closePopover()
    this.#refresh()
    testLog('UNIT_REVIEW_MODE', { enabled })
  }

  /**
   * Returns whether review mode is on.
   * @returns {boolean}
   */
  isEnabled() {
    return this.#enabled
  }

  /**
   * Returns the review units of the current document, after recomputing them.
   * @returns {Unit[]}
   */
  getUnits() {
    this.#refresh()
    return this.#scan.units.map(u => ({ ...u }))
  }

  /**
   * Returns the combined review counts of the current document.
   * @returns {ReviewSummary}
   */
  getSummary() {
    this.#refresh()
    return { ...this.#summary }
  }

  /**
   * Records marks of a reviewer that is not the current user, e.g. the LLM Reviewer. Units that
   * no longer exist are ignored.
   * @param {ExternalReviewer} reviewer
   * @param {ExternalMark[]} marks
   * @returns {Promise<boolean>} False if the marks could not be written (e.g. read-only document)
   */
  async setMarks(reviewer, marks) {
    this.#refresh()
    if (!this.#canWrite(false)) return false
    const who = { id: reviewer.id, name: reviewer.name ?? null, isLlm: reviewer.id.startsWith('llm-') }
    const current = new Set(this.#scan.units.map(u => u.fingerprint))
    const data = this.#readData(this.#view().state)
    for (const mark of marks) {
      if (!current.has(mark.fingerprint)) continue
      setMark(data, who, mark.fingerprint, mark.state, { comment: mark.comment ?? '' })
    }
    this.#write(data, true)
    return true
  }

  // ── Editor integration ─────────────────────────────────────────────

  /** @returns {EditorView} */
  #view() {
    return this.#xmlEditor.getView()
  }

  /**
   * The CodeMirror extensions of review mode.
   * @returns {any[]}
   */
  #extensions() {
    return [
      unitReviewGutter({
        mousedown: (view, line, event) => this.#onStripMouseDown(view, line, event),
        mouseover: (view, line) => this.#onStripMouseOver(view, line)
      }),
      Prec.high(keymap.of([
        { key: 'Mod-Enter', run: () => this.#markAtCursor('ok', false) },
        { key: 'Mod-Shift-Enter', run: () => this.#markAtCursor('not-ok', false) },
        { key: 'Mod-Alt-Enter', run: () => this.#markAtCursor('ok', true) },
        { key: 'Mod-Alt-Shift-Enter', run: () => this.#markAtCursor('not-ok', true) },
        { key: 'Mod-Shift-Backspace', run: () => this.#markAtCursor(null, false) },
        { key: 'F7', run: () => this.goToNext('open') },
        { key: 'Shift-F7', run: () => this.goToNext('not-ok') }
      ]))
    ]
  }

  /**
   * @param {ViewUpdate} update
   */
  #onEditorUpdate(update) {
    if (update.docChanged) {
      this.#pendingChanges = this.#pendingChanges ? this.#pendingChanges.compose(update.changes) : update.changes
      clearTimeout(this.#timer)
      this.#timer = setTimeout(() => this.#refresh({ persistCarry: true }), REFRESH_DELAY_MS)
    } else if (replacesDiagnostics(update) && this.#diagnosticsKey) {
      // another source replaced the diagnostics: merge ours in again (not from inside the update)
      this.#diagnosticsKey = ''
      setTimeout(() => this.#updateDiagnostics(), 0)
    }
  }

  #onDocumentLoaded() {
    clearTimeout(this.#timer)
    closePopover()
    this.#pendingChanges = null
    this.#carry = new Map()
    this.#scan = { units: [], looseText: [], complete: true, path: null }
    this.#fpCache = new Map()
    this.#refresh()
  }

  async #loadConfig() {
    const config = this.getDependency('config')
    try {
      const mode = await config.get('unit-review.mode', 'majority')
      this.#mode = mode === 'final' ? 'final' : 'majority'
      this.#llmVote = Boolean(await config.get('unit-review.llm-vote', true))
    } catch (e) {
      this.#logger.debug('[unit-review] config not available: ' + String(e))
    }
    try {
      const extractors = this.getDependency('extraction').extractorInfo() ?? await /** @type {any} */ (this.getDependency('client')).getExtractorList()
      /** @type {Record<string, string>} */
      const paths = {}
      for (const ext of extractors ?? []) Object.assign(paths, /** @type {any} */ (ext).reviewUnits ?? {})
      this.#variantPaths = paths
    } catch (e) {
      this.#logger.debug('[unit-review] extractor info not available: ' + String(e))
    }
  }

  /**
   * Returns the variant id of the loaded document.
   * @returns {string|null}
   */
  #documentVariant() {
    const xmlDoc = this.#xmlEditor.getXmlTree()
    const label = xmlDoc?.querySelector('application[type="extractor"] label[type="variant-id"]')
    return label?.textContent?.trim() || this.state?.variant || null
  }

  /**
   * Finds `TEI/standOff/listAnnotation[@type="unit-review"]` and related nodes in the syntax tree.
   * @param {EditorState} state
   * @returns {{root: SyntaxNode|null, teiHeader: SyntaxNode|null, standOff: SyntaxNode|null, list: SyntaxNode|null}}
   */
  #locate(state) {
    const read = (/** @type {number} */ from, /** @type {number} */ to) => state.doc.sliceString(from, to)
    /** @param {SyntaxNode} el */
    const nameOf = el => {
      const tag = el.getChild('OpenTag') ?? el.getChild('SelfClosingTag')
      const nameNode = tag?.getChild('TagName')
      return nameNode ? read(nameNode.from, nameNode.to).split(':').pop() : null
    }
    /** @param {SyntaxNode} el @param {string} attr */
    const attrOf = (el, attr) => {
      const tag = el.getChild('OpenTag') ?? el.getChild('SelfClosingTag')
      for (const a of tag?.getChildren('Attribute') ?? []) {
        const n = a.getChild('AttributeName')
        const v = a.getChild('AttributeValue')
        if (n && v && read(n.from, n.to) === attr) return read(v.from, v.to).replace(/^["']|["']$/g, '')
      }
      return null
    }
    const result = { root: /** @type {SyntaxNode|null} */ (null), teiHeader: null, standOff: null, list: null }
    const root = syntaxTree(state).topNode.getChild('Element')
    if (!root) return result
    result.root = root
    for (const child of root.getChildren('Element')) {
      const name = nameOf(child)
      if (name === 'teiHeader') result.teiHeader = /** @type {any} */ (child)
      if (name === 'standOff' && !result.list) {
        result.standOff = /** @type {any} */ (child)
        for (const list of child.getChildren('Element')) {
          if (nameOf(list) === 'listAnnotation' && attrOf(list, 'type') === LIST_TYPE) {
            result.list = /** @type {any} */ (list)
            break
          }
        }
      }
    }
    return result
  }

  /**
   * Reads the review data stored in the document (a fresh copy that may be modified).
   * @param {EditorState} state
   * @returns {ReviewData}
   */
  #readData(state) {
    const { list } = this.#locate(state)
    if (!list) return emptyReviewData()
    const text = state.doc.sliceString(list.from, list.to)
    const doc = new DOMParser().parseFromString(`<standOff xmlns="${TEI_NS}">${text}</standOff>`, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length) return emptyReviewData()
    return readReviewData(doc.documentElement.firstElementChild)
  }

  /**
   * Recomputes units, reads the review data and updates the strip, the meter and the diagnostics.
   * @param {{persistCarry?: boolean}} [options] - With persistCarry, marks of units edited since the
   *   last refresh are written to the document as carried-over marks
   */
  #refresh(options = {}) {
    clearTimeout(this.#timer)
    const view = this.#xmlEditor.getView?.()
    if (!view) return
    const state = view.state
    const data = this.#readData(state)
    const variantPath = this.#variantPaths[this.#documentVariant() ?? ''] ?? DEFAULT_UNIT_PATH
    this.#unitPath = data.unitPath ?? variantPath
    let scan
    try {
      scan = findUnits(state, this.#unitPath, this.#fpCache)
    } catch (e) {
      this.#logger.warn('[unit-review] ' + String(e))
      scan = { units: [], looseText: [], complete: true, path: null }
    }
    if (this.#fpCache.size > 5000) this.#fpCache = new Map()
    this.#updateCarry(scan)
    this.#scan = scan
    this.#data = data
    const { byFingerprint, summary } = combineReviews(scan.units, data, { mode: this.#mode, llmVote: this.#llmVote })
    this.#combined = byFingerprint
    this.#summary = summary
    this.#updateStrip(view)
    this.#updateMeter()
    this.#updateDiagnostics()
    if (options.persistCarry && this.#carry.size && data.reviewers.size && this.#canWrite(true)) {
      const copy = this.#readData(state)
      if (reconcileReviewData(copy, scan.units, this.#carry)) this.#write(copy, false)
    }
  }

  /**
   * Maps the units of the previous scan through the changes since then and records, for each unit
   * whose content changed, which fingerprint it had before.
   * @param {UnitScan} scan
   */
  #updateCarry(scan) {
    const changes = this.#pendingChanges
    this.#pendingChanges = null
    if (!changes || !this.#scan.units.length) return
    const byStart = new Map(scan.units.map(u => [u.from, u]))
    for (const old of this.#scan.units) {
      const from = changes.mapPos(old.from, 1)
      let unit = byStart.get(from)
      if (!unit) unit = scan.units.find(u => u.from <= from && from < u.to)
      if (!unit || unit.fingerprint === old.fingerprint) continue
      const root = this.#carry.get(old.fingerprint) ?? old.fingerprint
      if (root !== unit.fingerprint) this.#carry.set(unit.fingerprint, root)
    }
  }

  /**
   * Whether the current user may change the document's review data.
   * @param {boolean} silent - Do not notify the user
   * @returns {boolean}
   */
  #canWrite(silent) {
    /** @param {string} message */
    const fail = message => {
      if (!silent) notify(message, 'warning', 'exclamation-triangle')
      return false
    }
    if (!this.#xmlEditor.getXmlTree()) return fail('The XML is not well-formed: fix it before reviewing.')
    if (this.#xmlEditor.isReadOnly() || this.state?.editorReadOnly) return fail('The document is read-only.')
    if (this.#xmlEditor.isMergeViewActive()) return fail('Close the comparison view before reviewing.')
    if (!this.#scan.complete) return fail('The document is still being parsed, try again in a moment.')
    return true
  }

  /**
   * Whether the current user may set review marks.
   * @returns {boolean}
   */
  #isReviewer() {
    return userHasRole(this.state?.user ?? null, ['admin', 'reviewer'])
  }

  /**
   * Writes the review data into the document, replacing the existing review list.
   * @param {ReviewData} data
   * @param {boolean} addToHistory - False for automatic changes the user should not undo separately
   */
  #write(data, addToHistory) {
    const view = this.#view()
    const state = view.state
    reconcileReviewData(data, this.#scan.units, this.#carry)
    // record the path the units were found with, so that the units stay the same for all reviewers
    if (!data.unitPath || data.unitPath === DEFAULT_UNIT_PATH) data.unitPath = this.#scan.path ?? this.#unitPath
    const { summary } = combineReviews(this.#scan.units, data, { mode: this.#mode, llmVote: this.#llmVote })
    const located = this.#locate(state)
    const indentOf = (/** @type {number} */ pos) => {
      const line = state.doc.lineAt(pos)
      return /^\s*/.exec(line.text)?.[0] ?? ''
    }
    const unit = '  '
    const empty = data.reviewers.size === 0
    /** @type {{from: number, to?: number, insert: string}|null} */
    let change = null
    if (located.list) {
      if (empty) {
        // remove the list, or the whole standOff if nothing else is in it
        const standOff = /** @type {SyntaxNode} */ (located.standOff)
        const onlyChild = standOff.getChildren('Element').length === 1
        const node = onlyChild ? standOff : located.list
        const lineStart = state.doc.lineAt(node.from).from
        const before = state.doc.sliceString(lineStart, node.from)
        const from = /^\s*$/.test(before) ? Math.max(0, lineStart - 1) : node.from
        change = { from, to: node.to, insert: '' }
      } else {
        const indent = indentOf(located.list.from)
        const text = serializeReviewData(data, summary, indent, unit).slice(indent.length)
        change = { from: located.list.from, to: located.list.to, insert: text }
      }
    } else if (!empty) {
      if (located.standOff) {
        const close = located.standOff.getChild('CloseTag')
        const indent = indentOf(located.standOff.from) + unit
        const at = close ? close.from : located.standOff.to
        change = { from: at, insert: serializeReviewData(data, summary, indent, unit) + '\n' + indentOf(located.standOff.from) }
        // the close tag is usually preceded by the indentation of its own line
        const lineStart = state.doc.lineAt(at).from
        if (/^\s*$/.test(state.doc.sliceString(lineStart, at))) {
          change = { from: lineStart, to: at, insert: serializeReviewData(data, summary, indent, unit) + '\n' + indentOf(located.standOff.from) }
        }
      } else {
        const anchor = located.teiHeader ?? located.root?.getChild('OpenTag')
        if (!anchor) return
        const indent = located.teiHeader ? indentOf(located.teiHeader.from) : unit
        change = {
          from: anchor.to,
          insert: `\n${indent}<standOff>\n${serializeReviewData(data, summary, indent + unit, unit)}\n${indent}</standOff>`
        }
      }
    }
    if (!change) return
    // a new standOff starts folded (it holds no human-readable data), a folded one stays folded
    const keepFolded = !located.standOff || this.#isFolded(state, located.standOff)
    this.#writing = true
    try {
      view.dispatch({ changes: change, annotations: Transaction.addToHistory.of(addToHistory) })
      const standOff = this.#locate(view.state).standOff
      const range = standOff && keepFolded ? foldInside(standOff) : null
      if (range && !this.#isFolded(view.state, standOff)) view.dispatch({ effects: foldEffect.of(range) })
    } finally {
      this.#writing = false
    }
    this.#refresh()
    testLog('UNIT_REVIEW_WRITTEN', { ...this.#summary })
  }

  /**
   * Whether the content of an element is folded.
   * @param {EditorState} state
   * @param {SyntaxNode} node
   * @returns {boolean}
   */
  #isFolded(state, node) {
    const range = foldInside(node)
    if (!range) return false
    let folded = false
    foldedRanges(state).between(range.from, range.to, () => { folded = true; return false })
    return folded
  }

  /**
   * Makes sure the current user has a respStmt in the header, so `@resp` points somewhere.
   */
  async #ensureRespStmt() {
    const user = this.state?.user
    if (!user) return
    // the DOM tree is synced with a delay: bring it up to date, since it replaces the editor content
    await this.#xmlEditor.sync()
    const xmlDoc = this.#xmlEditor.getXmlTree()
    if (!xmlDoc || tei_utils.getRespStmtById(xmlDoc, user.username)) return
    tei_utils.ensureRespStmtForUser(xmlDoc, user.username, user.fullname || user.username, 'Reviewer')
    prettyPrintXmlDom(xmlDoc, 'teiHeader')
    await this.#xmlEditor.updateEditorFromXmlTree()
    this.#refresh()
  }

  /**
   * Sets the current user's mark on the given units.
   * @param {string[]} fingerprints
   * @param {MarkState|null} state
   * @param {{comment?: string, final?: boolean}} [options]
   * @returns {Promise<boolean>}
   */
  async markUnits(fingerprints, state, options = {}) {
    if (!this.#isReviewer()) {
      notify('Only reviewers can mark units.', 'warning', 'exclamation-triangle')
      return false
    }
    this.#refresh()
    if (!this.#canWrite(false) || !fingerprints.length) return false
    if (state !== null) await this.#ensureRespStmt()
    const user = /** @type {any} */ (this.state?.user)
    const data = this.#readData(this.#view().state)
    const final = Boolean(options.final) && this.#mode === 'final'
    for (const fp of fingerprints) {
      const comment = options.comment ?? (state === 'not-ok' ? data.reviewers.get(user.username)?.marks.get(fp)?.comment : '') ?? ''
      setMark(data, { id: user.username }, fp, state, { comment, final })
    }
    this.#write(data, true)
    return true
  }

  // ── Units, lines and navigation ────────────────────────────────────

  /**
   * Returns the units overlapping the given line range.
   * @param {number} fromLine
   * @param {number} toLine
   * @returns {Unit[]}
   */
  #unitsOnLines(fromLine, toLine) {
    const doc = this.#view().state.doc
    const from = doc.line(fromLine).from
    const to = doc.line(toLine).to
    return this.#scan.units.filter(u => u.from <= to && u.to >= from)
  }

  /**
   * Returns the units touched by the selection, or on the cursor line.
   * @returns {Unit[]}
   */
  #selectedUnits() {
    const state = this.#view().state
    /** @type {Unit[]} */
    const result = []
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number
      const last = state.doc.lineAt(range.to).number
      for (const unit of this.#unitsOnLines(first, last)) {
        if (!result.includes(unit)) result.push(unit)
      }
    }
    return result
  }

  /**
   * Keyboard command: marks the selected units and moves on.
   * @param {MarkState|null} state
   * @param {boolean} final
   * @returns {boolean}
   */
  #markAtCursor(state, final) {
    this.#refresh()
    const units = this.#selectedUnits()
    if (!units.length) {
      notify('There is no review unit here.', 'primary', 'info-circle')
      return true
    }
    if (final && this.#mode !== 'final') {
      notify('Final reviews are only available in the "final" review mode.', 'primary', 'info-circle')
      return true
    }
    const fps = units.map(u => u.fingerprint)
    const last = /** @type {Unit} */ (units[units.length - 1])
    this.markUnits(fps, state, { final }).then(done => {
      if (!done) return
      if (state === 'not-ok' && units.length === 1) {
        this.#promptComment(last, final)
      } else if (state !== null) {
        this.goToNext('open', this.#lineAfter(last))
      }
    })
    return true
  }

  /**
   * Shows the comment field for a unit just marked not OK.
   * @param {Unit} unit
   * @param {boolean} final
   */
  #promptComment(unit, final) {
    const view = this.#view()
    // writing the mark may have moved the unit: find it again by its fingerprint
    const index = this.#indexOfUnit(unit)
    const current = this.#scan.units[index] ?? unit
    const coords = view.coordsAtPos(current.from)
    if (!coords) return
    const line = view.state.doc.lineAt(current.from).number
    const user = /** @type {any} */ (this.state?.user)
    const existing = this.#data.reviewers.get(user.username)?.marks.get(current.fingerprint)?.comment ?? ''
    openCommentPrompt({ left: coords.left, bottom: coords.bottom }, `✕ Not OK · line ${line}`, existing, comment => {
      view.focus()
      if (comment === null) return
      this.#refresh()
      const fp = this.#scan.units[index]?.fingerprint ?? current.fingerprint
      this.markUnits([fp], 'not-ok', { comment, final }).then(() => this.goToNext('open', this.#lineAfter(current)))
    })
  }

  /**
   * Returns the last line of a unit, found again in the current unit list by its fingerprint.
   * @param {Unit} unit
   * @returns {number}
   */
  #lineAfter(unit) {
    const current = this.#scan.units[this.#indexOfUnit(unit)] ?? unit
    return this.#view().state.doc.lineAt(Math.min(current.to, this.#view().state.doc.length)).number
  }

  /**
   * Returns the index of a unit in the current unit list, matching by fingerprint (positions
   * change when the review list above the units is rewritten).
   * @param {Unit} unit
   * @returns {number}
   */
  #indexOfUnit(unit) {
    return this.#scan.units.findIndex(u => u.fingerprint === unit.fingerprint)
  }

  /**
   * Moves the cursor to the next unit the current user has not marked (`open`) or the next unit
   * whose combined state is not OK or disputed (`not-ok`), wrapping around.
   * @param {'open'|'not-ok'} kind
   * @param {number} [afterLine] - Defaults to the cursor line
   * @returns {boolean}
   */
  goToNext(kind, afterLine) {
    this.#refresh()
    const view = this.#view()
    const doc = view.state.doc
    const line = afterLine ?? doc.lineAt(view.state.selection.main.head).number
    const me = this.state?.user?.username ?? ''
    /** @param {Unit} unit */
    const wanted = unit => {
      const combined = this.#combined.get(unit.fingerprint)
      if (kind === 'not-ok') return combined?.state === 'not-ok' || combined?.state === 'disputed'
      return !this.#data.reviewers.get(me)?.marks.has(unit.fingerprint)
    }
    const units = this.#scan.units
    const after = units.filter(u => doc.lineAt(u.from).number > line && wanted(u))
    const target = after[0] ?? units.find(wanted)
    if (!target) {
      notify(kind === 'open' ? 'All units are reviewed.' : 'No units are marked not OK.', 'success', 'check-circle')
      return true
    }
    const targetLine = doc.lineAt(target.from)
    const anchor = targetLine.from + (/^\s*/.exec(targetLine.text)?.[0].length ?? 0)
    view.dispatch({ selection: { anchor: Math.max(anchor, target.from) }, scrollIntoView: true })
    view.focus()
    return true
  }

  // ── Strip ──────────────────────────────────────────────────────────

  /**
   * Returns a reviewer's display name.
   * @param {Reviewer} reviewer
   * @returns {string}
   */
  #reviewerName(reviewer) {
    if (reviewer.name) return reviewer.name
    const user = this.state?.user
    if (user && reviewer.id === user.username) return user.fullname || user.username
    const xmlDoc = this.#xmlEditor.getXmlTree()
    const respStmt = xmlDoc ? tei_utils.getRespStmtById(xmlDoc, reviewer.id) : null
    const persName = respStmt?.getElementsByTagName('persName')[0]?.textContent?.trim()
    return persName || reviewer.id
  }

  /**
   * Describes a combined state.
   * @param {CombinedUnit} combined
   * @returns {string}
   */
  #describe(combined) {
    const ok = combined.reviews.filter(r => r.mark.state === 'ok').length
    const notOk = combined.reviews.length - ok
    switch (combined.state) {
      case 'ok': return combined.final ? 'OK (final review)' : `OK (${ok} : ${notOk})`
      case 'not-ok': return combined.final ? 'Not OK (final review)' : `Not OK (${notOk} : ${ok})`
      case 'disputed': return `Disputed (${ok} OK · ${notOk} not OK), needs another review`
      case 'stale': return 'Edited since it was reviewed, needs a new review'
      default: return 'Unreviewed'
    }
  }

  /**
   * Tooltip text for a unit.
   * @param {Unit} unit
   * @returns {string}
   */
  #unitTitle(unit) {
    const combined = this.#combined.get(unit.fingerprint)
    if (!combined) return ''
    const lines = [`<${unit.name}> · ${this.#describe(combined)}`]
    for (const { reviewer, mark } of combined.reviews) {
      const sign = mark.state === 'ok' ? '✓' : '✕'
      lines.push(`${sign} ${this.#reviewerName(reviewer)}${mark.final ? ' (final)' : ''} · ${formatWhen(reviewer.when)}${mark.comment ? `: ${mark.comment}` : ''}`)
    }
    for (const { reviewer, mark } of combined.was) {
      lines.push(`before the last edit: ${mark.state === 'ok' ? 'OK' : 'not OK'} (${this.#reviewerName(reviewer)})${mark.comment ? `: ${mark.comment}` : ''}`)
    }
    return lines.join('\n')
  }

  /**
   * Computes the line marks and sets them in the editor.
   * @param {EditorView} view
   */
  #updateStrip(view) {
    if (!this.#enabled) return
    const doc = view.state.doc
    /** @type {Map<number, {states: Set<string>, titles: string[], loose: boolean}>} */
    const lines = new Map()
    const entry = (/** @type {number} */ n) => {
      let e = lines.get(n)
      if (!e) lines.set(n, e = { states: new Set(), titles: [], loose: false })
      return e
    }
    for (const unit of this.#scan.units) {
      if (unit.to > doc.length) continue
      const state = this.#combined.get(unit.fingerprint)?.state ?? 'open'
      const title = this.#unitTitle(unit)
      const first = doc.lineAt(unit.from).number
      const last = doc.lineAt(unit.to).number
      for (let n = first; n <= last; n++) {
        const e = entry(n)
        e.states.add(state)
        if (n === first) e.titles.push(title)
      }
    }
    for (const range of this.#scan.looseText) {
      if (range.to > doc.length) continue
      const first = doc.lineAt(range.from).number
      const last = doc.lineAt(range.to).number
      for (let n = first; n <= last; n++) if (lines.has(n)) entry(n).loose = true
    }
    /** @type {LineMark[]} */
    const marks = []
    for (const [line, e] of lines) {
      /** @type {LineMarkState|null} */
      let state = null
      if (e.states.size > 1 || (e.loose && [...e.states].some(s => s !== 'open'))) {
        state = 'uncertain'
      } else {
        const only = /** @type {string} */ ([...e.states][0])
        if (only !== 'open') state = /** @type {LineMarkState} */ (only)
      }
      if (this.#drag) {
        const lo = Math.min(this.#drag.startLine, this.#drag.endLine)
        const hi = Math.max(this.#drag.startLine, this.#drag.endLine)
        if (line >= lo && line <= hi) state = 'drag'
      }
      if (!state) continue
      let title = e.titles.join('\n\n')
      if (state === 'uncertain') title = 'Several units with different reviews on this line. Pretty-print the document to put each unit on its own line.\n\n' + title
      marks.push({ line, state, title })
    }
    view.dispatch({ effects: setUnitReviewMarkersEffect.of(buildUnitReviewMarkers(doc, marks)) })
  }

  /**
   * @param {EditorView} view
   * @param {BlockInfo} line
   * @param {MouseEvent} event
   * @returns {boolean}
   */
  #onStripMouseDown(view, line, event) {
    if (event.button !== 0) return false
    const n = view.state.doc.lineAt(line.from).number
    this.#drag = { startLine: n, endLine: n, notOk: event.altKey }
    event.preventDefault()
    return true
  }

  /**
   * @param {EditorView} view
   * @param {BlockInfo} line
   * @returns {boolean}
   */
  #onStripMouseOver(view, line) {
    if (!this.#drag) return false
    const n = view.state.doc.lineAt(line.from).number
    if (n !== this.#drag.endLine) {
      this.#drag.endLine = n
      this.#updateStrip(view)
    }
    return true
  }

  #endDrag() {
    const drag = this.#drag
    if (!drag) return
    this.#drag = null
    const view = this.#view()
    if (drag.startLine === drag.endLine) {
      this.#updateStrip(view)
      this.openReview(drag.startLine)
      return
    }
    const units = this.#unitsOnLines(Math.min(drag.startLine, drag.endLine), Math.max(drag.startLine, drag.endLine))
    this.#updateStrip(view)
    if (units.length) this.markUnits(units.map(u => u.fingerprint), drag.notOk ? 'not-ok' : 'ok')
  }

  /**
   * Opens the review popover for the units on a line.
   * @param {number} line - 1-based line number
   */
  openReview(line) {
    this.#refresh()
    const view = this.#view()
    const units = this.#unitsOnLines(line, line)
    const unit = units[0]
    if (!unit) return
    const coords = view.coordsAtPos(view.state.doc.line(line).from)
    if (!coords) return
    const user = /** @type {any} */ (this.state?.user)
    const combined = /** @type {CombinedUnit} */ (this.#combined.get(unit.fingerprint))
    const mine = combined.reviews.find(r => r.reviewer.id === user?.username)
    /** @type {PopoverReview[]} */
    const others = [
      ...combined.reviews.filter(r => r !== mine).map(({ reviewer, mark }) => ({
        who: this.#reviewerName(reviewer), state: mark.state, comment: mark.comment,
        when: reviewer.when, final: mark.final, was: false
      })),
      ...combined.was.map(({ reviewer, mark }) => ({
        who: this.#reviewerName(reviewer), state: mark.state, comment: mark.comment,
        when: reviewer.when, final: false, was: true
      }))
    ]
    const text = view.state.doc.sliceString(unit.from, Math.min(unit.to, unit.from + 200)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    const readOnly = !this.#isReviewer() || !this.#canWrite(true)
    openReviewPopover({
      at: { left: coords.left, bottom: coords.bottom },
      title: `Line ${line}`,
      subtitle: `<${unit.name}> ${text.slice(0, 60)}`,
      state: mine?.mark.state ?? null,
      comment: mine?.mark.comment ?? '',
      final: Boolean(mine?.mark.final),
      canFinal: this.#mode === 'final' && this.#isReviewer(),
      others,
      combined: `Combined: ${this.#describe(combined)}`,
      note: units.length > 1 ? `${units.length} units share this line; your review applies to all of them.` : undefined,
      readOnly,
      onSave: ({ state, comment, final }) => {
        const fps = this.#unitsOnLines(line, line).map(u => u.fingerprint)
        this.markUnits(fps, state, { comment, final }).then(() => view.focus())
      }
    })
  }

  // ── Meter, diagnostics, context menu ───────────────────────────────

  /** @returns {HTMLElement} */
  #createMeter() {
    const meter = document.createElement('span')
    meter.className = 'unit-review-meter'
    meter.dataset.testid = 'unit-review-meter'
    meter.style.cssText = 'display:none;align-items:center;gap:6px;cursor:pointer;font-size:12px;padding:0 6px;white-space:nowrap'
    meter.title = 'Review progress. Click to go to the next unit you have not reviewed (F7).'
    meter.innerHTML = '<span class="ur-bar" style="display:inline-flex;width:90px;height:7px;border-radius:4px;overflow:hidden;background:var(--sl-color-neutral-200,#e4e6ea)"><i style="background:#2f9e57"></i><i style="background:#d64545"></i><i style="background:#e0a020"></i></span><span class="ur-text"></span>'
    meter.addEventListener('click', () => this.goToNext('open'))
    return meter
  }

  #updateMeter() {
    const meter = this.#meter
    if (!meter) return
    const s = this.#summary
    const visible = this.#enabled && s.units > 0
    meter.style.display = visible ? 'inline-flex' : 'none'
    if (!visible) return
    const bars = /** @type {HTMLElement[]} */ (Array.from(meter.querySelectorAll('.ur-bar i')))
    const pct = (/** @type {number} */ n) => `${(n / s.units) * 100}%`
    ;/** @type {HTMLElement} */ (bars[0]).style.width = pct(s.ok)
    ;/** @type {HTMLElement} */ (bars[1]).style.width = pct(s.notOk)
    ;/** @type {HTMLElement} */ (bars[2]).style.width = pct(s.disputed)
    const parts = [`${s.ok} OK`, `${s.notOk} not OK`]
    if (s.disputed) parts.push(`${s.disputed} disputed`)
    parts.push(`${s.open} open`)
    ;/** @type {HTMLElement} */ (meter.querySelector('.ur-text')).textContent = parts.join(' · ')
  }

  /**
   * Lists not-OK and disputed units in the diagnostics drawer.
   */
  #updateDiagnostics() {
    const view = this.#xmlEditor.getView?.()
    if (!view) return
    const state = view.state
    const llmRanges = collectDiagnostics(state).filter(d => d.source === LLM_REVIEW_SOURCE)
    /** @type {Diagnostic[]} */
    const own = []
    for (const unit of this.#scan.units) {
      if (unit.to > state.doc.length) continue
      const combined = this.#combined.get(unit.fingerprint)
      if (!combined || (combined.state !== 'not-ok' && combined.state !== 'disputed')) continue
      const humanNotOk = combined.reviews.some(r => !r.reviewer.isLlm && r.mark.state === 'not-ok')
      if (!humanNotOk && combined.state === 'not-ok' && llmRanges.some(d => d.from < unit.to && d.to > unit.from)) continue
      const comments = combined.reviews
        .filter(r => r.mark.state === 'not-ok')
        .map(r => `${this.#reviewerName(r.reviewer)}${r.mark.comment ? `: ${r.mark.comment}` : ''}`)
      const line = state.doc.lineAt(unit.from)
      const fp = unit.fingerprint
      own.push({
        from: unit.from,
        to: Math.min(unit.to, line.to),
        severity: 'info',
        message: `${combined.state === 'disputed' ? 'Review disputed' : 'Marked not OK'} (${comments.join('; ')})`,
        actions: [
          { name: '✓ OK', apply: () => { this.markUnits([fp], 'ok') } },
          { name: '✕ Not OK', apply: () => { this.markUnits([fp], 'not-ok') } },
          { name: 'Open review', apply: (v, from) => { this.openReview(v.state.doc.lineAt(from).number) } }
        ]
      })
    }
    const key = own.map(d => `${d.from}:${d.to}:${d.message}`).join('|')
    if (key === this.#diagnosticsKey) return
    this.#diagnosticsKey = key
    // not from inside a dispatch
    setTimeout(() => applyMergedDiagnostics(view, SOURCE, own), 0)
  }

  /**
   * Context menu items of review mode.
   * @returns {Array<{element: HTMLElement, onBeforeShow?: (ctx: {readOnly: boolean}) => void}>}
   */
  getContextMenuItems() {
    /**
     * @param {string} label
     * @param {() => void} run
     * @returns {HTMLElement}
     */
    const item = (label, run) => {
      const el = document.createElement('sl-menu-item')
      el.textContent = label
      el.addEventListener('click', run)
      return el
    }
    const divider = document.createElement('sl-divider')
    const items = [
      divider,
      item('Mark as OK', () => this.#markAtCursor('ok', false)),
      item('Mark as not OK…', () => this.#markAtCursor('not-ok', false)),
      item('Remove my review', () => this.#markAtCursor(null, false)),
      item('Mark everything above as OK', () => this.#markAbove()),
      item('Next unreviewed unit', () => this.goToNext('open'))
    ]
    const onBeforeShow = () => {
      for (const el of items) el.hidden = !this.#enabled || (el !== divider && !this.#isReviewer() && !el.textContent?.startsWith('Next'))
    }
    return items.map(element => ({ element, onBeforeShow }))
  }

  /**
   * Marks all units the current user has not marked, from the start of the document up to the
   * cursor line, as OK.
   */
  #markAbove() {
    this.#refresh()
    const view = this.#view()
    const line = view.state.doc.lineAt(view.state.selection.main.head).number
    const me = this.state?.user?.username ?? ''
    const units = this.#unitsOnLines(1, line).filter(u => !this.#data.reviewers.get(me)?.marks.has(u.fingerprint))
    if (units.length) this.markUnits(units.map(u => u.fingerprint), 'ok')
  }
}

export default UnitReviewPlugin
