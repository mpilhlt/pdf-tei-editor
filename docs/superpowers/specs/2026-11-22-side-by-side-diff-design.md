# Side-by-side diff window

## Intent

The merge view in the XML editor uses CodeMirror's unified diff (`unifiedMergeView`), where deleted and inserted lines are interleaved. For longer changes this is hard to read. A read-only side-by-side diff (CodeMirror's `MergeView` from `@codemirror/merge`, already a dependency) in a separate window makes comparing easier, while accepting/rejecting stays in the main editor.

## Goals

- A button in the merge view widget group of the XML editor toolbar opens a new browser window with a side-by-side diff of the open document and the version selected in "Compare with version".
- The window is read-only.
- Live updates: the window follows the main window — another compared version, edits in the document (including accepting/rejecting chunks) and the strict-diff toggle re-render it.
- The window closes automatically when the merge view in the main editor is hidden (Esc, "Compare with version" cleared, accept/reject all, loading another document, logout), and when the main window unloads.

## Non-goals

- Editing, accepting or rejecting changes in the window.
- A bookmarkable/reloadable window URL; the window lives only as long as the main window drives it.

## Approaches

1. **Window drawn from the main window (chosen).** `window.open('about:blank', …)`, then mount `MergeView` into the new document using its `root` option. Uses the text the editor already holds, including unsaved edits; no new page, bundle or server route; live updates are direct calls.
2. **Standalone page like `guide.html`.** Needs a Rollup bundle, importmap entry and FastAPI route; the page fetches both versions itself and can only show saved content; live updates would need a message channel. Rejected: more infrastructure, worse fit for live updates.

## Design

- **XMLEditor module** (`app/src/modules/xmleditor.js`) keeps owning the diff inputs. New `getMergeViewDocuments()` returns `{ current, incoming, titles }` (current editor text, the incoming text after the same whitespace normalization the unified view uses, the edition titles) or `null` when no merge view is active. When `showMergeView()` replaces an active merge view, the `EVENT_EDITOR_HIDE_MERGE_VIEW` event carries `{ replaced: true }`, so listeners can tell a version switch from ending the merge view.
- **New module** `app/src/modules/side-by-side-diff-window.js`: class `SideBySideDiffWindow` with `open(docs)`, `update(docs)`, `close()`, `isOpen()`. Writes a minimal document (header with the two titles, container), creates a `MergeView` with `xml()`, the editor's syntax highlighting, line numbers, line wrapping, `EditorState.readOnly` and `EditorView.editable.of(false)` on both sides, `collapseUnchanged` off. `update()` replaces both documents in place so scroll position is kept. Reusing a named window (`pte-side-by-side-diff`) brings an existing one to the front.
- **merge-view plugin** adds a `sideBySideBtn` (`layout-split` icon, tooltip "Show side-by-side diff in a new window") after the strict-diff toggle; it is enabled whenever the merge view is shown, also in read-only documents. `window.open` happens synchronously in the click handler (popup blockers). Live update triggers: `EVENT_EDITOR_SHOW_MERGE_VIEW`, `EVENT_EDITOR_DELAYED_UPDATE` and the strict-diff toggle. `EVENT_EDITOR_HIDE_MERGE_VIEW` without `replaced` closes the window; `pagehide` of the main window closes it too.
- **Layout (my call):** compared version on the left, open document on the right (old → new reading direction), each side labelled with its edition title.

## Left to the builder

- Styling of the window header; window size (proposal: 1400×900).
- Tests: a unit test for `getMergeViewDocuments()`/the `replaced` flag if feasible in the existing XMLEditor test setup; an E2E test that opens the window, checks both sides and that it closes on Esc in the main window.
