/**
 * A browser window with a read-only side-by-side diff of two XML documents, using CodeMirror's
 * `MergeView`. The window is drawn and updated from the opening window, so it shows the text the
 * caller passes in (including unsaved edits) and has no URL of its own.
 */

/**
 * @import { Extension } from '@codemirror/state'
 * @import { MergeViewDocuments } from './xmleditor.js'
 */

import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers, highlightSpecialChars } from '@codemirror/view'
import { MergeView } from '@codemirror/merge'
import { xml } from '@codemirror/lang-xml'

/** Name of the browser window, so that only one side-by-side diff window exists */
const WINDOW_NAME = 'pte-side-by-side-diff'

const WINDOW_FEATURES = 'popup,width=1400,height=900'

const WINDOW_STYLE = `
  html, body { margin: 0; height: 100%; }
  body { display: flex; flex-direction: column; font-family: system-ui, sans-serif; font-size: 14px; }
  .sbs-header { display: flex; flex: none; border-bottom: 1px solid #ccc; background: #f5f5f5; }
  .sbs-header > div { flex: 1; padding: 6px 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sbs-header > div + div { border-left: 1px solid #ccc; }
  .sbs-label { color: #666; margin-right: 6px; }
  .sbs-diff { flex: 1; overflow: auto; }
  .sbs-diff .cm-mergeView { min-height: 100%; }
  .sbs-diff .cm-editor { font-size: 13px; }
`

/**
 * Options for a side-by-side diff window
 * @typedef {object} SideBySideDiffWindowOptions
 * @property {Extension[]} [theme] - CodeMirror theme extensions (e.g. the XML editor's theme)
 * @property {string} [title] - The window title
 */

export class SideBySideDiffWindow {
  /** @type {Window | null} */
  #window = null

  /** @type {MergeView | null} */
  #mergeView = null

  /** @type {HTMLElement | null} */
  #incomingTitle = null

  /** @type {HTMLElement | null} */
  #currentTitle = null

  /** @type {SideBySideDiffWindowOptions} */
  #options

  /** @param {SideBySideDiffWindowOptions} [options] */
  constructor(options = {}) {
    this.#options = options
  }

  /**
   * Whether the window is open (the user may have closed it)
   * @returns {boolean}
   */
  isOpen() {
    return this.#window !== null && !this.#window.closed
  }

  /**
   * Opens the window with the given documents, or updates and focuses it if it is already open.
   * Must be called synchronously from a user action, otherwise the popup blocker may prevent it.
   * @param {MergeViewDocuments} docs
   * @param {SideBySideDiffWindowOptions} [options] - Replaces the options given to the constructor
   * @returns {boolean} False if the window could not be opened (popup blocked)
   */
  open(docs, options) {
    if (options) this.#options = options
    if (this.isOpen() && this.#mergeView) {
      this.update(docs)
      this.#window?.focus()
      return true
    }
    const win = window.open('about:blank', WINDOW_NAME, WINDOW_FEATURES)
    if (!win) return false
    this.#window = win
    this.#render(win, docs)
    win.focus()
    return true
  }

  /**
   * Shows other documents in the open window, keeping the scroll position. Does nothing if the
   * window is not open.
   * @param {MergeViewDocuments} docs
   */
  update(docs) {
    if (!this.isOpen() || !this.#mergeView) return
    this.#setTitles(docs)
    for (const [view, text] of /** @type {[EditorView, string][]} */ ([[this.#mergeView.a, docs.incoming], [this.#mergeView.b, docs.current]])) {
      if (view.state.doc.toString() === text) continue
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    }
  }

  /** Closes the window if it is open */
  close() {
    this.#mergeView?.destroy()
    this.#mergeView = null
    if (this.isOpen()) this.#window?.close()
    this.#window = null
  }

  /**
   * Builds the window content
   * @param {Window} win
   * @param {MergeViewDocuments} docs
   */
  #render(win, docs) {
    const doc = win.document
    doc.title = this.#options.title ?? 'Side-by-side diff'
    doc.head.replaceChildren()
    doc.body.replaceChildren()

    const style = doc.createElement('style')
    style.textContent = WINDOW_STYLE
    doc.head.appendChild(style)

    const header = doc.createElement('div')
    header.className = 'sbs-header'
    this.#incomingTitle = doc.createElement('div')
    this.#currentTitle = doc.createElement('div')
    header.append(this.#incomingTitle, this.#currentTitle)
    const container = doc.createElement('div')
    container.className = 'sbs-diff'
    doc.body.append(header, container)
    this.#setTitles(docs)

    const extensions = [
      lineNumbers(),
      highlightSpecialChars(),
      xml(),
      EditorView.lineWrapping,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      ...(this.#options.theme ?? [])
    ]
    this.#mergeView?.destroy()
    this.#mergeView = new MergeView({
      a: { doc: docs.incoming, extensions },
      b: { doc: docs.current, extensions },
      parent: container,
      root: doc,
      highlightChanges: true,
      gutter: true,
      diffConfig: { scanLimit: 50000, timeout: 20000 }
    })

    // the window content cannot be restored after a reload, as it is drawn from the opening window
    win.addEventListener('pagehide', () => {
      if (this.#window === win) {
        this.#mergeView = null
        this.#window = null
      }
    })
  }

  /** @param {MergeViewDocuments} docs */
  #setTitles(docs) {
    if (!this.#incomingTitle || !this.#currentTitle) return
    this.#setTitle(this.#incomingTitle, 'Compared version:', docs.titles.incoming)
    this.#setTitle(this.#currentTitle, 'Current document:', docs.titles.current)
  }

  /**
   * @param {HTMLElement} el
   * @param {string} label
   * @param {string} title
   */
  #setTitle(el, label, title) {
    const doc = /** @type {Document} */ (el.ownerDocument)
    const labelEl = doc.createElement('span')
    labelEl.className = 'sbs-label'
    labelEl.textContent = label
    el.replaceChildren(labelEl, doc.createTextNode(title || ''))
    el.title = title || ''
  }
}
