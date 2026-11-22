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
  .sbs-header > div { flex: 1; min-width: 0; display: flex; align-items: center; padding: 0 0 0 12px; }
  .sbs-header > div + div { border-left: 1px solid #ccc; }
  .sbs-title { flex: 1; padding: 6px 12px 6px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sbs-sync { flex: none; display: flex; align-items: center; gap: 4px; padding: 0 8px; white-space: nowrap; cursor: pointer; }
  .sbs-close { flex: none; margin: 3px 6px; padding: 2px 12px; font: inherit; cursor: pointer; }
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
 * @property {boolean} [syncScroll] - Initial state of the "Sync with editor" checkbox
 * @property {(enabled: boolean) => void} [onSyncScrollChange] - Called when the user toggles the checkbox
 * @property {(lineNumber: number) => void} [onScrollLine] - Called with the line of the current
 *   document at the top of the window when the user scrolls the window while syncing is enabled
 */

/** Time in ms during which scroll events caused by `scrollToLine()` are not reported */
const PROGRAMMATIC_SCROLL_MS = 300

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

  /** @type {HTMLElement | null} The scrolling container of both editors */
  #container = null

  /** @type {HTMLInputElement | null} */
  #syncCheckbox = null

  /** Scroll events before this time (performance.now()) were caused by `scrollToLine()` */
  #ignoreScrollUntil = 0

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

  /**
   * Whether the "Sync with editor" checkbox is checked
   * @returns {boolean}
   */
  isSyncEnabled() {
    return this.isOpen() && Boolean(this.#syncCheckbox?.checked)
  }

  /**
   * Scrolls the window so that the given line of the current document is at the top, if syncing is
   * enabled. The resulting scroll events are not reported to `onScrollLine`.
   * @param {number} lineNumber - 1-based line number of the current document
   */
  scrollToLine(lineNumber) {
    if (!this.isSyncEnabled() || !this.#mergeView || !this.#container) return
    const view = this.#mergeView.b
    const doc = view.state.doc
    const line = doc.line(Math.max(1, Math.min(lineNumber, doc.lines)))
    // CodeMirror measures the lines before scrolling the container (estimated heights of lines
    // that were not drawn yet would leave the target off by a few pixels)
    this.#ignoreScrollUntil = performance.now() + PROGRAMMATIC_SCROLL_MS
    view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 0 }) })
    // CodeMirror scrolls in an animation frame, which browsers throttle in a window in the
    // background: check the position afterwards and correct it directly if necessary
    const container = this.#container
    setTimeout(() => {
      if (this.#container !== container || line.from > view.state.doc.length) return
      const offset = view.lineBlockAt(line.from).top - (container.scrollTop - this.#documentOffset(view))
      if (Math.abs(offset) < 1) return
      this.#ignoreScrollUntil = performance.now() + PROGRAMMATIC_SCROLL_MS
      container.scrollTop += offset
    }, 100)
  }

  /** Closes the window if it is open */
  close() {
    this.#mergeView?.destroy()
    this.#mergeView = null
    this.#container = null
    this.#syncCheckbox = null
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
    const incomingCell = doc.createElement('div')
    const currentCell = doc.createElement('div')
    this.#incomingTitle = doc.createElement('span')
    this.#incomingTitle.className = 'sbs-title'
    this.#currentTitle = doc.createElement('span')
    this.#currentTitle.className = 'sbs-title'
    const closeBtn = doc.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'sbs-close'
    closeBtn.textContent = 'Close'
    closeBtn.addEventListener('click', () => this.close())
    const syncLabel = doc.createElement('label')
    syncLabel.className = 'sbs-sync'
    syncLabel.title = 'Scroll this window and the XML editor together, by the line numbers of the current document'
    const syncCheckbox = doc.createElement('input')
    syncCheckbox.type = 'checkbox'
    syncCheckbox.name = 'syncScroll'
    syncCheckbox.checked = this.#options.syncScroll ?? true
    syncCheckbox.addEventListener('change', () => this.#options.onSyncScrollChange?.(syncCheckbox.checked))
    syncLabel.append(syncCheckbox, doc.createTextNode('Sync with editor'))
    this.#syncCheckbox = syncCheckbox
    incomingCell.append(this.#incomingTitle)
    currentCell.append(this.#currentTitle, syncLabel, closeBtn)
    header.append(incomingCell, currentCell)
    const container = doc.createElement('div')
    container.className = 'sbs-diff'
    this.#container = container
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

    // CodeMirror redraws the visible lines on scrolling only while its IntersectionObserver reports
    // the editor as visible. That observer is created in the realm of the opening window and does
    // not see elements in this window (blank areas in Firefox), so request the measurement here.
    const mergeView = this.#mergeView
    const measure = () => {
      mergeView.a.requestMeasure()
      mergeView.b.requestMeasure()
    }
    container.addEventListener('scroll', measure, { passive: true })
    container.addEventListener('scroll', () => this.#onScroll(), { passive: true })
    win.addEventListener('resize', measure)
    win.addEventListener('keydown', (evt) => { if (evt.key === 'Escape') this.close() })

    // the window content cannot be restored after a reload, as it is drawn from the opening window
    win.addEventListener('pagehide', () => {
      if (this.#window === win) {
        this.#mergeView = null
        this.#window = null
      }
    })
  }

  /** Reports the line at the top of the window to `onScrollLine` when the user scrolls */
  #onScroll() {
    if (!this.isSyncEnabled() || !this.#mergeView || !this.#container) return
    if (performance.now() < this.#ignoreScrollUntil) return
    const view = this.#mergeView.b
    const block = view.lineBlockAtHeight(Math.max(0, this.#container.scrollTop - this.#documentOffset(view)))
    this.#options.onScrollLine?.(view.state.doc.lineAt(block.from).number)
  }

  /**
   * Distance of the top of the editor's document from the top of the scrolled content
   * @param {EditorView} view
   * @returns {number}
   */
  #documentOffset(view) {
    const container = /** @type {HTMLElement} */ (this.#container)
    return view.documentTop - container.getBoundingClientRect().top + container.scrollTop
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
