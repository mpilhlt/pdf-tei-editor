/**
 * @import { Extension } from '@codemirror/state'
 */

/**
 * Search/replace support for CodeMirror instances embedded in Shoelace dialogs.
 */

import { EditorView, ViewPlugin, keymap } from "@codemirror/view"
import { highlightSelectionMatches, searchKeymap, searchPanelOpen } from "@codemirror/search"

/**
 * Keeps an Escape that closes the search panel from also closing the
 * surrounding `<sl-dialog>`. In browsers without `CloseWatcher` (Firefox,
 * Safari), Shoelace listens for Escape on `document` and ignores
 * `defaultPrevented`.
 * CodeMirror closes the panel before the event bubbles up to `view.dom`, so
 * whether the panel was open is recorded in the capture phase and the event
 * is stopped in the bubble phase.
 */
const escapeGuard = ViewPlugin.fromClass(class {
  /** @param {EditorView} view */
  constructor(view) {
    this.view = view
    this.panelWasOpen = false
    /** @param {KeyboardEvent} event */
    this.onCapture = (event) => {
      this.panelWasOpen = event.key === 'Escape' && searchPanelOpen(view.state)
    }
    /** @param {KeyboardEvent} event */
    this.onBubble = (event) => {
      if (event.key === 'Escape' && this.panelWasOpen) event.stopPropagation()
      this.panelWasOpen = false
    }
    view.dom.addEventListener('keydown', this.onCapture, true)
    view.dom.addEventListener('keydown', this.onBubble)
  }

  destroy() {
    this.view.dom.removeEventListener('keydown', this.onCapture, true)
    this.view.dom.removeEventListener('keydown', this.onBubble)
  }
})

/**
 * Search/replace extensions matching the main XML editor's (`searchKeymap`
 * and `highlightSelectionMatches()`, see xmleditor.js), plus a guard so that
 * Escape in the search panel doesn't close the enclosing dialog.
 *
 * The `tabindex` keeps the content focusable while `EditorView.editable` is
 * false (contenteditable="false" elements aren't focusable on their own), so
 * the search keymap also works on read-only content.
 * @returns {Extension}
 */
export function dialogSearch() {
  return [
    highlightSelectionMatches(),
    keymap.of(searchKeymap),
    EditorView.contentAttributes.of({ tabindex: '0' }),
    escapeGuard
  ]
}
