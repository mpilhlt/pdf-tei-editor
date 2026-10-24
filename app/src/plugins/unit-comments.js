/**
 * Unit Comments Plugin
 *
 * Lets every user who can edit a document attach comments to elements, instead of writing XML
 * comments into the text. Comments form threads with replies and can be resolved. They are
 * stored stand-off in `TEI/standOff/listAnnotation[@type="unit-comment"]`, anchored on the
 * element by its XPath and a fingerprint of its content (see modules/node-anchor.js).
 * See docs/user-manual/unit-comments.md for the user documentation.
 *
 * Like the review marks, the comments are part of the document text: commenting edits the
 * `standOff` element, so undo, saving and versions work as for any other edit.
 *
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { EditorView, BlockInfo, ViewUpdate } from '@codemirror/view'
 * @import { ChangeSet } from '@codemirror/state'
 * @import { Diagnostic } from '@codemirror/lint'
 * @import { UnitComment, CommentThread, ThreadStatus } from '../modules/unit-comments.js'
 * @import { AnchoredElement } from '../modules/node-anchor.js'
 * @import { CommentLineMark } from '../modules/codemirror/unit-comment-gutter.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import { keymap, EditorView as View } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { notify } from '../modules/sl-utils.js'
import { userHasRole } from '../modules/acl-utils.js'
import { testLog } from '../modules/test-log.js'
import * as tei_utils from '../modules/tei-utils.js'
import { applyMergedDiagnostics, collectDiagnostics, replacesDiagnostics, drawerOnlyDiagnostics } from '../modules/lint-utils.js'
import { readStandOffList, writeStandOffList, ensureUserRespStmt } from '../modules/standoff-list.js'
import {
  LIST_TYPE, readComments, serializeComments, buildThreads, addThread, addReply, setThreadStatus,
  editComment, deleteComment
} from '../modules/unit-comments.js'
import { elementAt, elementPath, resolveAnchor, FingerprintCache } from '../modules/node-anchor.js'
import { unitCommentGutter, buildUnitCommentMarkers, setUnitCommentMarkersEffect } from '../modules/codemirror/unit-comment-gutter.js'
import { openCommentPrompt, closePopover } from '../modules/unit-review-popover.js'
import { openThreadPopover } from '../modules/unit-comment-popover.js'

/** Diagnostic source tag of this plugin's diagnostics */
const SOURCE = 'unit-comment'

/** Delay after the last edit before the anchors are resolved again */
const REFRESH_DELAY_MS = 250

const IS_MAC = /Mac/.test(navigator.userAgent)

/** Shortcut for a new comment, as shown to the user */
const SHORTCUT = IS_MAC ? '⌘Shift+M' : 'Ctrl+Shift+M'

/**
 * A thread and the element it is anchored on
 * @typedef {object} PlacedThread
 * @property {CommentThread} thread
 * @property {AnchoredElement|null} element - Null if the element was not found (detached)
 */

/**
 * A thread as returned by {@link UnitCommentsPlugin#getThreads}
 * @typedef {object} ThreadInfo
 * @property {string} id
 * @property {ThreadStatus} status
 * @property {string|null} path - XPath of the element, null if detached
 * @property {number|null} line - First line of the element
 * @property {string} text - Text of the first comment
 * @property {number} replies
 */

class UnitCommentsPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'unit-comments', deps: ['xmleditor', 'logger'] })
  }

  get #xmlEditor() { return this.getDependency('xmleditor') }

  /** @type {{ reconfigure: (ext: any) => void }|null} */
  #slot = null

  /** Whether the gutter is part of the editor extensions (only while the document has comments) */
  #gutterShown = false

  /** @type {HTMLElement|null} */
  #meter = null

  /** @type {UnitComment[]} Comments read at the last refresh (a fresh copy that may be modified) */
  #comments = []

  /** @type {PlacedThread[]} */
  #placed = []

  #cache = new FingerprintCache()

  /** @type {Map<string, number>} Element start by thread id, tracked through the edits of this session */
  #positions = new Map()

  /** @type {ChangeSet|null} Document changes since the last refresh */
  #pendingChanges = null

  /** @type {ReturnType<typeof setTimeout>|undefined} */
  #timer = undefined

  /** @type {string} Key of the diagnostics last applied, to avoid redundant dispatches */
  #diagnosticsKey = ''

  /** True while this plugin dispatches its own diagnostics */
  #renderingDiagnostics = false

  #writing = false

  /** @param {ApplicationState} state */
  async install(state) {
    await super.install(state)
    this.#slot = this.#xmlEditor.createExtensionSlot(this.#extensions())
    this.#meter = this.#createMeter()
    this.#xmlEditor.addStatusbarWidget(this.#meter, 'right', 5)
    this.#xmlEditor.addUpdateListener(update => this.#onEditorUpdate(update))
    this.#xmlEditor.on('editorAfterLoad', () => this.#onDocumentLoaded())
  }

  async start() {
    this.#refresh()
  }

  static extensionPoints = [ep.xmlEditor.contextMenuItems];

  /**
   * Extension point handler for `ep.xmlEditor.contextMenuItems`.
   * Delegates to {@link UnitCommentsPlugin#getContextMenuItems}.
   * @returns {Array<{element: HTMLElement, prepend: boolean, onBeforeShow: (ctx: {readOnly: boolean, pos: number}) => void}>}
   */
  [ep.xmlEditor.contextMenuItems]() { return this.getContextMenuItems() }

  async onUserChange() {
    this.#refresh()
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Returns the comment threads of the current document, after resolving their anchors again.
   * @returns {ThreadInfo[]}
   */
  getThreads() {
    this.#refresh()
    const doc = this.#view().state.doc
    return this.#placed.map(({ thread, element }) => ({
      id: thread.root.id,
      status: thread.status,
      path: element?.path ?? null,
      line: element ? doc.lineAt(element.from).number : null,
      text: thread.root.text,
      replies: thread.replies.length
    }))
  }

  /**
   * Asks for a comment on the element at a position and adds it as a new thread.
   * @param {number} [pos] - Defaults to the cursor
   */
  addComment(pos) {
    this.#refresh()
    if (!this.#canWrite(false)) return
    const view = this.#view()
    const at = pos ?? view.state.selection.main.head
    const node = elementAt(view.state, at)
    if (!node) {
      notify('Place the cursor in an element of the document to comment on it.', 'primary', 'info-circle')
      return
    }
    const read = (/** @type {number} */ from, /** @type {number} */ to) => view.state.doc.sliceString(from, to)
    const anchor = { path: elementPath(node, read), fingerprint: this.#cache.get(node, read) }
    const name = read(node.from, node.to).match(/^<([^\s/>]+)/)?.[1] ?? 'element'
    const coords = view.coordsAtPos(node.from)
    if (!coords) return
    const line = view.state.doc.lineAt(node.from).number
    openCommentPrompt({ left: coords.left, bottom: coords.bottom }, `Comment on <${name}> · line ${line}`, '', text => {
      view.focus()
      if (!text) return
      this.#addThread(anchor, text)
    }, { placeholder: 'Comment', hint: 'Enter: save · Esc: cancel', testid: 'unit-comment-prompt' })
  }

  /**
   * Opens the popover of a thread.
   * @param {string} threadId
   */
  openThread(threadId) {
    this.#refresh()
    const placed = this.#placed.find(p => p.thread.root.id === threadId)
    if (!placed) return
    const view = this.#view()
    const { thread, element } = placed
    const editorRect = view.dom.getBoundingClientRect()
    const coords = element ? view.coordsAtPos(element.from) : null
    const at = coords ? { left: coords.left, bottom: coords.bottom } : { left: editorRect.left + 40, bottom: editorRect.top + 40 }
    const me = this.state?.user?.username ?? ''
    const isAdmin = userHasRole(this.state?.user ?? null, ['admin'])
    const canWrite = this.#canWrite(true)
    const text = element ? view.state.doc.sliceString(element.tagTo, Math.min(element.to, element.tagTo + 200)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : ''
    openThreadPopover({
      at,
      title: element ? `Comment · line ${view.state.doc.lineAt(element.from).number}` : 'Comment',
      subtitle: element ? `<${element.name}> ${text.slice(0, 50)}` : '',
      status: thread.status,
      note: element ? undefined : `The element (${thread.root.path ?? '?'}) was not found. Delete the comment, or ask an admin to correct its target in the standOff.`,
      comments: [thread.root, ...thread.replies].map(c => ({
        id: c.id,
        who: this.#displayName(c.author),
        when: c.changes[0]?.when ?? null,
        text: c.text,
        edited: c.changes.some(ch => ch.status === 'edited'),
        canEdit: canWrite && c.author === me,
        canDelete: canWrite && (c.author === me || isAdmin)
      })),
      canWrite,
      onReply: text => this.#change(comments => { addReply(comments, threadId, { author: me, text }) }, threadId, true),
      onStatus: status => this.#change(comments => { setThreadStatus(comments, threadId, status, { who: me }) }, threadId),
      onEdit: (id, text) => this.#change(comments => { editComment(comments, id, text, { who: me }) }, threadId),
      onDelete: id => this.#change(comments => deleteComment(comments, id), threadId)
    })
  }

  /**
   * Moves the cursor to the next element with an open comment thread, wrapping around.
   * @returns {boolean}
   */
  goToNextOpen() {
    this.#refresh()
    const view = this.#view()
    const head = view.state.selection.main.head
    const open = this.#placed
      .filter(p => p.thread.status === 'open' && p.element)
      .map(p => /** @type {AnchoredElement} */ (p.element).from)
      .sort((a, b) => a - b)
    const target = open.find(from => from > head) ?? open[0]
    if (target === undefined) {
      notify('There are no open comments.', 'success', 'check-circle')
      return true
    }
    view.dispatch({ selection: { anchor: target + 1 }, scrollIntoView: true })
    view.focus()
    return true
  }

  // ── Editor integration ─────────────────────────────────────────────

  /** @returns {EditorView} */
  #view() {
    return this.#xmlEditor.getView()
  }

  /**
   * The CodeMirror extensions: the shortcut always, the gutter while the document has comments.
   * @returns {any[]}
   */
  #extensions() {
    return [
      Prec.high(keymap.of([{ key: 'Mod-Shift-m', run: () => { this.addComment(); return true } }])),
      // the comments' state and actions are in the gutter and the popover: no hover tooltip
      drawerOnlyDiagnostics(SOURCE),
      this.#gutterShown ? unitCommentGutter((view, line) => this.#onGutterClick(view, line)) : []
    ]
  }

  /**
   * @param {ViewUpdate} update
   */
  #onEditorUpdate(update) {
    if (update.docChanged) {
      // our own writes move the elements too
      this.#pendingChanges = this.#pendingChanges ? this.#pendingChanges.compose(update.changes) : update.changes
      if (this.#writing) return
      clearTimeout(this.#timer)
      this.#timer = setTimeout(() => this.#refresh({ persistAnchors: true }), REFRESH_DELAY_MS)
    } else if (replacesDiagnostics(update) && this.#diagnosticsKey && !this.#renderingDiagnostics
      && !collectDiagnostics(update.state).some(d => d.source === SOURCE)) {
      // another source replaced the diagnostics without ours: merge ours in again
      this.#diagnosticsKey = ''
      setTimeout(() => this.#updateDiagnostics(), 0)
    }
  }

  #onDocumentLoaded() {
    clearTimeout(this.#timer)
    closePopover()
    this.#pendingChanges = null
    this.#positions = new Map()
    this.#refresh()
  }

  /**
   * Reads the comments, resolves their anchors and updates the gutter, the meter and the diagnostics.
   * @param {{persistAnchors?: boolean}} [options] - With persistAnchors, anchors that changed
   *   through edits are written to the document
   */
  #refresh(options = {}) {
    clearTimeout(this.#timer)
    const view = this.#xmlEditor.getView?.()
    if (!view) return
    const state = view.state
    const changes = this.#pendingChanges
    this.#pendingChanges = null
    if (changes) {
      for (const [id, pos] of this.#positions) this.#positions.set(id, changes.mapPos(pos, 1))
    }
    this.#comments = readComments(readStandOffList(state, LIST_TYPE))
    this.#placed = buildThreads(this.#comments).map(thread => {
      const element = resolveAnchor(state, { path: thread.root.path, fingerprint: thread.root.fingerprint }, this.#cache, this.#positions.get(thread.root.id) ?? null)
      if (element) this.#positions.set(thread.root.id, element.from)
      else this.#positions.delete(thread.root.id)
      return { thread, element }
    })
    const needGutter = this.#placed.length > 0
    if (needGutter !== this.#gutterShown) {
      this.#gutterShown = needGutter
      this.#slot?.reconfigure(this.#extensions())
    }
    this.#updateGutter(view)
    this.#updateMeter()
    this.#updateDiagnostics()
    if (options.persistAnchors && this.#anchorsChanged() && this.#canWrite(true)) this.#write(false)
  }

  /**
   * Whether an element moved or changed since its anchor was written.
   * @returns {boolean}
   */
  #anchorsChanged() {
    return this.#placed.some(({ thread, element }) => element && (element.path !== thread.root.path || element.fingerprint !== thread.root.fingerprint))
  }

  /**
   * Whether the current user may change the document's comments.
   * @param {boolean} silent - Do not notify the user
   * @returns {boolean}
   */
  #canWrite(silent) {
    /** @param {string} message */
    const fail = message => {
      if (!silent) notify(message, 'warning', 'exclamation-triangle')
      return false
    }
    if (!this.state?.user) return fail('Log in to comment.')
    if (!this.#xmlEditor.getXmlTree()) return fail('The XML is not well-formed: fix it before commenting.')
    // not the editor's own read-only flag: annotation mode sets it to block typing only
    if (this.state.editorReadOnly) return fail('The document is read-only. Create your own version to comment.')
    if (this.#xmlEditor.isMergeViewActive()) return fail('Close the comparison view before commenting.')
    return true
  }

  /**
   * Writes the comments into the document, with the anchors of all found elements brought up to date.
   * @param {boolean} addToHistory - False for automatic changes the user should not undo separately
   */
  #write(addToHistory) {
    for (const { thread, element } of this.#placed) {
      if (!element) continue
      thread.root.path = element.path
      thread.root.fingerprint = element.fingerprint
    }
    const comments = this.#comments
    this.#writing = true
    try {
      writeStandOffList(this.#view(), LIST_TYPE, (indent, unit) => comments.length ? serializeComments(comments, indent, unit) : null, addToHistory)
    } finally {
      this.#writing = false
    }
    this.#refresh()
    const open = this.#placed.filter(p => p.thread.status === 'open').length
    testLog('UNIT_COMMENTS_WRITTEN', { threads: this.#placed.length, open })
  }

  /**
   * Scrolls a thread's element into view: adding the respStmt replaces the editor content, which
   * scrolls to the top.
   * @param {string} threadId
   */
  #reveal(threadId) {
    const element = this.#placed.find(p => p.thread.root.id === threadId)?.element
    if (element) this.#view().dispatch({ effects: View.scrollIntoView(element.from, { y: 'nearest' }) })
  }

  /**
   * Applies a change to the current comments and writes them.
   * @param {(comments: UnitComment[]) => (UnitComment[]|void)} change - May modify the list or return a new one
   * @param {string} threadId - The thread to keep in view
   * @param {boolean} [addsComment] - Makes sure the user has a respStmt first
   */
  async #change(change, threadId, addsComment = false) {
    if (!this.#canWrite(false)) return
    if (addsComment) await ensureUserRespStmt(this.#xmlEditor, this.state?.user, 'Commenter')
    this.#refresh()
    const result = change(this.#comments)
    if (result) {
      const ids = new Set(result.map(c => c.id))
      this.#comments = result
      this.#placed = this.#placed.filter(p => ids.has(p.thread.root.id))
    }
    this.#write(true)
    this.#reveal(threadId)
    this.#view().focus()
  }

  /**
   * Adds a thread on the element with the given anchor.
   * @param {{path: string, fingerprint: string}} anchor
   * @param {string} text
   */
  async #addThread(anchor, text) {
    const me = this.state?.user?.username
    if (!me || !this.#canWrite(false)) return
    await ensureUserRespStmt(this.#xmlEditor, this.state?.user, 'Commenter')
    this.#refresh()
    // the respStmt may have moved the element
    const element = resolveAnchor(this.#view().state, anchor, this.#cache)
    if (!element) {
      notify('The element was changed in the meantime, the comment was not added.', 'warning', 'exclamation-triangle')
      return
    }
    const comment = addThread(this.#comments, { author: me, text, path: element.path, fingerprint: element.fingerprint })
    this.#placed.push({ thread: { root: comment, replies: [], status: 'open' }, element })
    this.#write(true)
    this.#reveal(comment.id)
    testLog('UNIT_COMMENT_ADDED', { id: comment.id, path: element.path })
  }

  /**
   * Returns a user's display name.
   * @param {string} id
   * @returns {string}
   */
  #displayName(id) {
    const user = this.state?.user
    if (user && id === user.username) return user.fullname || user.username
    const xmlDoc = this.#xmlEditor.getXmlTree()
    const respStmt = xmlDoc ? tei_utils.getRespStmtById(xmlDoc, id) : null
    return respStmt?.getElementsByTagName('persName')[0]?.textContent?.trim() || id
  }

  // ── Gutter, meter, diagnostics, context menu ───────────────────────

  /**
   * @param {EditorView} view
   */
  #updateGutter(view) {
    if (!this.#gutterShown) return
    const doc = view.state.doc
    /** @type {Map<number, CommentLineMark>} */
    const lines = new Map()
    for (const { thread, element } of this.#placed) {
      if (!element || element.from > doc.length) continue
      const line = doc.lineAt(element.from).number
      const title = `${this.#displayName(thread.root.author)}: ${thread.root.text}${thread.replies.length ? ` (+${thread.replies.length})` : ''}${thread.status === 'resolved' ? ' · resolved' : ''}`
      const mark = lines.get(line)
      if (mark) {
        mark.count++
        mark.title += '\n' + title
        if (thread.status === 'open') mark.state = 'open'
      } else {
        lines.set(line, { line, state: thread.status, count: 1, title })
      }
    }
    view.dispatch({ effects: setUnitCommentMarkersEffect.of(buildUnitCommentMarkers(doc, [...lines.values()])) })
  }

  /**
   * Opens the thread of a gutter line: the first open one, or the first one.
   * @param {EditorView} view
   * @param {BlockInfo} line
   * @returns {boolean}
   */
  #onGutterClick(view, line) {
    const doc = view.state.doc
    const n = doc.lineAt(line.from).number
    const onLine = this.#placed.filter(p => p.element && doc.lineAt(p.element.from).number === n)
    const target = onLine.find(p => p.thread.status === 'open') ?? onLine[0]
    if (!target) return false
    this.openThread(target.thread.root.id)
    return true
  }

  /** @returns {HTMLElement} */
  #createMeter() {
    const meter = document.createElement('span')
    meter.dataset.testid = 'unit-comment-meter'
    meter.style.cssText = 'display:none;align-items:center;gap:4px;cursor:pointer;font-size:12px;padding:0 6px;white-space:nowrap;color:#0b6bcb'
    meter.addEventListener('click', () => this.goToNextOpen())
    return meter
  }

  #updateMeter() {
    const meter = this.#meter
    if (!meter) return
    const open = this.#placed.filter(p => p.thread.status === 'open').length
    meter.style.display = open ? 'inline-flex' : 'none'
    meter.textContent = `💬 ${open} open comment${open === 1 ? '' : 's'}`
    meter.title = 'Click to go to the next open comment'
  }

  /**
   * Lists the open threads in the diagnostics drawer.
   */
  #updateDiagnostics() {
    const view = this.#xmlEditor.getView?.()
    if (!view) return
    const doc = view.state.doc
    /** @type {Diagnostic[]} */
    const own = []
    for (const { thread, element } of this.#placed) {
      if (thread.status !== 'open') continue
      if (element && element.tagTo > doc.length) continue
      const id = thread.root.id
      const replies = thread.replies.length ? ` (+${thread.replies.length} ${thread.replies.length === 1 ? 'reply' : 'replies'})` : ''
      own.push({
        from: element?.from ?? 0,
        to: element ? element.tagTo : 0,
        severity: 'info',
        message: `${element ? '' : 'Element not found: '}💬 ${this.#displayName(thread.root.author)}: ${thread.root.text}${replies}`,
        actions: [
          { name: 'Reply', apply: () => { this.openThread(id) } },
          { name: 'Resolve', apply: () => { this.#change(comments => { setThreadStatus(comments, id, 'resolved', { who: this.state?.user?.username ?? '' }) }, id) } }
        ]
      })
    }
    const key = own.map(d => `${d.from}:${d.to}:${d.message}`).join('|')
    if (key === this.#diagnosticsKey) return
    this.#diagnosticsKey = key
    // not from inside a dispatch
    setTimeout(() => {
      this.#renderingDiagnostics = true
      try {
        applyMergedDiagnostics(view, SOURCE, own)
      } finally {
        this.#renderingDiagnostics = false
      }
    }, 0)
  }

  /**
   * The "Comment…" entry at the top of the editor's context menu, for the right-clicked element.
   * @returns {Array<{element: HTMLElement, prepend: boolean, onBeforeShow: (ctx: {readOnly: boolean, pos: number}) => void}>}
   */
  getContextMenuItems() {
    let pos = 0
    const item = document.createElement('sl-menu-item')
    item.dataset.testid = 'unit-comment-menu-item'
    item.innerHTML = '<sl-icon slot="prefix" name="chat-left-text"></sl-icon>Comment…<span slot="suffix" class="xml-editor-context-menu__shortcut"></span>'
    ;/** @type {HTMLElement} */ (item.querySelector('[slot="suffix"]')).textContent = SHORTCUT
    item.title = 'Add a comment to the element you right-clicked. Comments are stored in the document and listed in the diagnostics drawer.'
    item.addEventListener('click', () => this.addComment(pos))
    const divider = document.createElement('sl-divider')
    /** @param {{readOnly: boolean, pos: number}} ctx */
    const onBeforeShow = ctx => {
      pos = ctx.pos
      const visible = Boolean(this.state?.user)
      item.hidden = divider.hidden = !visible
      if (visible) item.disabled = !this.#canWrite(true) || !elementAt(this.#view().state, pos)
    }
    return [{ element: item, prepend: true, onBeforeShow }, { element: divider, prepend: true, onBeforeShow }]
  }
}

export default UnitCommentsPlugin
