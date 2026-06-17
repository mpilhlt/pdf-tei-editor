/**
 * Self-contained right-click context menu for the XML editor.
 *
 * Builds its own DOM, wires all event listeners, and exposes a minimal API:
 * - `mount(parent)` — attach to the editor panel once
 * - `addItem(element)` — append a contributed <sl-menu-item> or <sl-divider>
 *
 * No dependency on the template system or navigable-element infrastructure.
 *
 * @import { XMLEditor } from '../xmleditor.js'
 */

import { undo, redo, selectAll, undoDepth, redoDepth } from '@codemirror/commands'
import { acceptChunk, rejectChunk, getChunks } from '@codemirror/merge'

/** True when running on macOS — used to pick ⌘ vs Ctrl shortcut labels. */
const IS_MAC = /Mac/.test(navigator.userAgent);

/**
 * @param {string} label
 * @param {string} shortcut
 * @returns {HTMLElement}
 */
function makeMenuItem(label, shortcut) {
  const item = document.createElement('sl-menu-item');
  item.textContent = label;
  const kbd = document.createElement('span');
  kbd.slot = 'suffix';
  kbd.className = 'xml-editor-context-menu__shortcut';
  kbd.textContent = IS_MAC ? shortcut.replace('Ctrl+', '⌘') : shortcut;
  item.appendChild(kbd);
  return item;
}

export class XmlEditorContextMenu {
  /** @param {XMLEditor} editor */
  constructor(editor) {
    this.#editor = editor;
  }

  /** @type {XMLEditor} */
  #editor;

  /** @type {HTMLElement|null} */
  #overlay = null;
  /** @type {HTMLButtonElement|null} */
  #undoBtn = null;
  /** @type {HTMLButtonElement|null} */
  #redoBtn = null;
  /** @type {HTMLElement|null} */
  #diffRow = null;
  /** @type {HTMLButtonElement|null} */
  #acceptBtn = null;
  /** @type {HTMLButtonElement|null} */
  #rejectBtn = null;
  /** @type {HTMLElement|null} */
  #copyItem = null;
  /** @type {HTMLElement|null} */
  #cutItem = null;
  /** @type {HTMLElement|null} */
  #pasteItem = null;
  /** @type {HTMLElement|null} */
  #menu = null;
  /** @type {HTMLElement|null} */
  #pluginDivider = null;
  /** @type {HTMLElement|null} */
  #unwrapItem = null;
  /** @type {number} */
  #clickDocPos = 0;
  /** @type {Array<(ctx: {readOnly: boolean}) => void>} */
  #beforeShowCallbacks = [];

  /**
   * Build the DOM and attach to *parent*. Call exactly once after construction.
   * @param {HTMLElement} parent
   */
  mount(parent) {
    // Outer overlay (fixed position, hidden by default)
    const overlay = document.createElement('div');
    overlay.className = 'xml-editor-context-menu';
    overlay.style.display = 'none';

    // History row
    const historyRow = document.createElement('div');
    historyRow.className = 'xml-editor-context-menu__history-row';

    const historyLabel = document.createElement('span');
    historyLabel.className = 'xml-editor-context-menu__history-label';
    historyLabel.textContent = 'History';

    const undoBtn = document.createElement('button');
    undoBtn.className = 'xml-editor-context-menu__history-btn';
    undoBtn.textContent = 'Undo';

    const redoBtn = document.createElement('button');
    redoBtn.className = 'xml-editor-context-menu__history-btn';
    redoBtn.textContent = 'Redo';

    historyRow.append(historyLabel, undoBtn, redoBtn);
    overlay.appendChild(historyRow);

    // Diff row — shown only when right-clicking inside a merge-view chunk
    const diffRow = document.createElement('div');
    diffRow.className = 'xml-editor-context-menu__history-row';
    diffRow.style.display = 'none';

    const diffLabel = document.createElement('span');
    diffLabel.className = 'xml-editor-context-menu__history-label';
    diffLabel.textContent = 'Change';

    // Labels and colors match the CodeMirror chunk buttons shown in the editor gutter:
    //   "Current"  (orange, left)  — keep the unannotated editor text → acceptChunk
    //   "Incoming" (blue,   right) — apply the annotation            → rejectChunk
    // Note: rejectChunk applies the annotation because showMergeView() passes the
    // annotated XML as `original` (B), making "revert to original" mean "use annotation".
    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'xml-editor-context-menu__history-btn xml-editor-context-menu__history-btn--accept';
    acceptBtn.textContent = 'Current';

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'xml-editor-context-menu__history-btn xml-editor-context-menu__history-btn--reject';
    rejectBtn.textContent = 'Incoming';

    diffRow.append(diffLabel, acceptBtn, rejectBtn);
    overlay.appendChild(diffRow);

    // sl-menu with built-in items
    const menu = document.createElement('sl-menu');

    const copyItem    = makeMenuItem('Copy',       'Ctrl+C');
    const cutItem     = makeMenuItem('Cut',        'Ctrl+X');
    const pasteItem   = makeMenuItem('Paste',      'Ctrl+V');
    const sep         = document.createElement('sl-divider');
    const selAllItem  = makeMenuItem('Select All', 'Ctrl+A');
    const editSep     = document.createElement('sl-divider');
    const unwrapItem  = document.createElement('sl-menu-item');
    unwrapItem.textContent = 'Remove tag';
    const pluginDiv   = document.createElement('sl-divider');
    pluginDiv.style.display = 'none';

    menu.append(copyItem, cutItem, pasteItem, sep, selAllItem, editSep, unwrapItem, pluginDiv);
    overlay.appendChild(menu);

    parent.appendChild(overlay);

    // Store references
    this.#overlay       = overlay;
    this.#undoBtn       = undoBtn;
    this.#redoBtn       = redoBtn;
    this.#diffRow       = diffRow;
    this.#acceptBtn     = acceptBtn;
    this.#rejectBtn     = rejectBtn;
    this.#copyItem      = copyItem;
    this.#cutItem       = cutItem;
    this.#pasteItem     = pasteItem;
    this.#menu          = menu;
    this.#pluginDivider = pluginDiv;
    this.#unwrapItem    = unwrapItem;

    // Bind commands
    undoBtn.addEventListener('click',   () => { undo(this.#editor.getView());       this.#hide(); });
    redoBtn.addEventListener('click',   () => { redo(this.#editor.getView());       this.#hide(); });
    copyItem.addEventListener('click',  () => this.#copy());
    cutItem.addEventListener('click',   () => this.#cut());
    pasteItem.addEventListener('click', () => this.#paste());
    selAllItem.addEventListener('click',() => { selectAll(this.#editor.getView()); this.#hide(); });
    unwrapItem.addEventListener('click', () => this.#unwrapAtClickPos());

    // Close the menu on any sl-menu item click (covers plugin-contributed items)
    menu.addEventListener('click', () => this.#hide());

    // Suppress the sl-select event so clicking menu items doesn't bubble oddly
    menu.addEventListener('sl-select', evt => evt.stopPropagation());

    // Show on right-click inside the CodeMirror container
    const cm = document.getElementById('codemirror-container');
    cm?.addEventListener('contextmenu', evt => {
      evt.preventDefault();
      this.#show(evt.clientX, evt.clientY);
    });

    // Dismiss on outside click or Escape
    document.addEventListener('click', evt => {
      if (this.#overlay && !this.#overlay.contains(/** @type {Node} */(evt.target))) {
        this.#hide();
      }
    });
    document.addEventListener('keydown', evt => {
      if (evt.key === 'Escape') this.#hide();
    });
  }

  /**
   * Append a contributed item (sl-menu-item or sl-divider) to the plugin section.
   * Automatically reveals the section divider on first call.
   * @param {HTMLElement} element
   * @param {{ onBeforeShow?: (ctx: {readOnly: boolean}) => void }} [options]
   */
  addItem(element, options) {
    this.#menu?.appendChild(element);
    if (this.#pluginDivider) this.#pluginDivider.style.display = '';
    if (options?.onBeforeShow) this.#beforeShowCallbacks.push(options.onBeforeShow);
  }

  /**
   * Prepend a contributed item before all other menu items.
   * @param {HTMLElement} element
   * @param {{ onBeforeShow?: (ctx: {readOnly: boolean}) => void }} [options]
   */
  prependItem(element, options) {
    if (this.#menu) this.#menu.insertBefore(element, this.#menu.firstChild);
    if (options?.onBeforeShow) this.#beforeShowCallbacks.push(options.onBeforeShow);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /** @param {number} x @param {number} y */
  #show(x, y) {
    const view = this.#editor.getView();
    const { from, to } = view.state.selection.main;
    const hasSelection = from !== to;
    const readOnly     = this.#editor.isReadOnly();

    // Give contributed items a chance to update themselves before the menu appears
    for (const cb of this.#beforeShowCallbacks) cb({ readOnly });

    // Record click position for deferred commands (unwrap, accept/reject)
    this.#clickDocPos = view.posAtCoords({ x, y }, false) ?? view.state.selection.main.head;

    if (this.#undoBtn)   this.#undoBtn.disabled   = undoDepth(view.state) === 0;
    if (this.#redoBtn)   this.#redoBtn.disabled   = redoDepth(view.state) === 0;
    if (this.#copyItem)  this.#copyItem.disabled  = !hasSelection;
    if (this.#cutItem)   this.#cutItem.disabled   = !hasSelection || readOnly;
    if (this.#pasteItem) this.#pasteItem.disabled = readOnly;

    // Enable "Remove tag" when the cursor is inside a non-root element and editor is editable
    if (this.#unwrapItem) {
      let canUnwrap = false;
      if (!readOnly && this.#editor.isSynced()) {
        try {
          const domNode = /** @type {Element} */ (this.#editor.getDomNodeAt(this.#clickDocPos));
          canUnwrap = domNode.parentElement !== null;
        } catch { /* not in a mappable element */ }
      }
      this.#unwrapItem.disabled = !canUnwrap;
    }

    // Show "Incoming"/"Current" buttons only when right-clicking inside a merge-view chunk.
    //
    // In showMergeView() the annotated XML is passed as `original` (B) and the
    // unannotated editor content is A. So from the user's perspective:
    //   "Incoming" = apply the annotation  → CodeMirror rejectChunk (reverts A to B)
    //   "Current"  = keep unannotated text → CodeMirror acceptChunk (keeps A, discards B)
    // This is the OPPOSITE of what the CodeMirror API names suggest.
    //
    // The incoming block widget is placed at ch.fromB (the B-document position) in
    // the editor's decoration set, NOT at ch.fromA. posAtCoords() on the widget
    // therefore returns a position near fromB. We check both ranges so clicks on
    // either the current (A) or incoming (B) visual area are detected.
    // DEBUG: enable to inspect position mapping when clicking in merge view.
    let chunkPos = null;
    if (this.#editor.isMergeViewActive()) {
      const clickPos = this.#clickDocPos;
      const { chunks } = getChunks(view.state) || {};
      // The incoming block widget is rendered visually ABOVE fromA (it's a block
      // decoration with side:-1). posAtCoords() returns a position before fromA
      // when the user clicks in that widget area. Detect this by falling back to
      // a y-coordinate check: if the click is above the chunk's first screen line
      // it must be inside the incoming widget for that chunk.
      const chunk = chunks?.find(c => {
        if (clickPos >= c.fromA && clickPos <= Math.max(c.toA, c.fromA)) return true;
        if (clickPos < c.fromA) {
          const coords = view.coordsAtPos(c.fromA);
          return coords !== null && y < coords.top;
        }
        return false;
      });
      if (chunk != null) chunkPos = chunk.fromA;
    }
    if (this.#diffRow) this.#diffRow.style.display = chunkPos !== null ? '' : 'none';
    if (chunkPos !== null) {
      if (this.#acceptBtn) this.#acceptBtn.onclick = () => {
        // "Current": keep the unannotated editor text (A), discard annotation (B)
        acceptChunk(view, chunkPos);
        this.#hideIfNoDiffs(view);
        this.#hide();
      };
      if (this.#rejectBtn) this.#rejectBtn.onclick = () => {
        // "Incoming": apply annotation — rejectChunk reverts A to B (the annotated original)
        rejectChunk(view, chunkPos);
        this.#hideIfNoDiffs(view);
        this.#hide();
      };
    }

    if (!this.#overlay) return;
    // Clamp to viewport so the menu never spills off-screen
    const menuW = 240, menuH = 300;
    this.#overlay.style.left    = `${Math.min(x, window.innerWidth  - menuW)}px`;
    this.#overlay.style.top     = `${Math.min(y, window.innerHeight - menuH)}px`;
    this.#overlay.style.display = '';
  }

  /**
   * Hide the merge view if no diff chunks remain after an accept/reject.
   * @param {import('@codemirror/view').EditorView} view
   */
  #hideIfNoDiffs(view) {
    const { chunks } = getChunks(view.state) || {};
    if (!chunks || chunks.length === 0) {
      this.#editor.hideMergeView();
    }
  }

  async #unwrapAtClickPos() {
    try {
      const domNode = /** @type {Element} */ (this.#editor.getDomNodeAt(this.#clickDocPos));
      const parent = domNode.parentNode;
      if (!parent || !domNode.parentElement) return; // refuse to unwrap root
      while (domNode.firstChild) {
        parent.insertBefore(domNode.firstChild, domNode);
      }
      parent.removeChild(domNode);
      await this.#editor.updateEditorFromNode(parent);
    } catch (err) {
      console.warn('xml-editor-context-menu: unwrap failed:', err.message);
    }
  }

  #hide() {
    if (this.#overlay) this.#overlay.style.display = 'none';
  }

  async #copy() {
    const view = this.#editor.getView();
    const { from, to } = view.state.selection.main;
    if (from === to) return;
    await navigator.clipboard.writeText(view.state.doc.sliceString(from, to));
    this.#hide();
  }

  async #cut() {
    if (this.#editor.isReadOnly()) return;
    const view = this.#editor.getView();
    const { from, to } = view.state.selection.main;
    if (from === to) return;
    await navigator.clipboard.writeText(view.state.doc.sliceString(from, to));
    view.dispatch({ changes: { from, to, insert: '' }, userEvent: 'delete' });
    this.#hide();
  }

  async #paste() {
    if (this.#editor.isReadOnly()) return;
    const text = await navigator.clipboard.readText();
    if (!text) return;
    const view = this.#editor.getView();
    const { from, to } = view.state.selection.main;
    view.dispatch({ changes: { from, to, insert: text }, userEvent: 'input.paste' });
    this.#hide();
  }
}
