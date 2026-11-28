/**
 * @import { Extension } from '@codemirror/state'
 */

/**
 * Selection-match highlighting that steps aside while the search panel is open.
 *
 * `highlightSelectionMatches()` marks every occurrence of the selected text.
 * The search panel marks every occurrence of the query. When the panel is
 * opened with a selection, the panel's query starts out as the selected text,
 * and if the query is then edited, both sets of highlights are shown at the
 * same time, which looks as if the search matched text it did not (#962).
 * CodeMirror itself only hides selection matches that overlap a search match
 * (`.cm-searchMatch .cm-selectionMatch`); this extension hides all of them
 * while the panel is open.
 */

import { EditorView } from "@codemirror/view"
import { highlightSelectionMatches, searchPanelOpen } from "@codemirror/search"

/** Class set on the editor element while the search panel is open. */
export const SEARCH_OPEN_CLASS = 'cm-search-open'

/**
 * @returns {Extension} `highlightSelectionMatches()` plus the rules that hide
 *   its highlights while the search panel is open
 */
export function selectionMatches() {
  return [
    highlightSelectionMatches(),
    EditorView.editorAttributes.of(view =>
      searchPanelOpen(view.state) ? { class: SEARCH_OPEN_CLASS } : null),
    EditorView.theme({
      [`&.${SEARCH_OPEN_CLASS} .cm-selectionMatch`]: { backgroundColor: 'transparent' }
    })
  ]
}
