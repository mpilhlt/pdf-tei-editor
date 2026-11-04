# Header stays folded when a unit review is recorded (#660)

## Problem

Marking the first unit of a document as "OK" unfolded the teiHeader, while the toolbar's header
toggle stayed in the "folded" state.

The first mark of a reviewer calls `ensureUserRespStmt()` (`app/src/modules/standoff-list.js`),
which adds the reviewer's `respStmt` to the header in the XML DOM and then calls
`XMLEditor.updateEditorFromXmlTree()`. That method replaced the whole editor text in one change.
CodeMirror drops every fold whose range is replaced, so the header fold disappeared without an
unfold effect, and the `tei-tools` plugin, which syncs the toggle from fold/unfold effects, never
noticed.

## Fix

- `updateEditorFromXmlTree()` (`app/src/modules/xmleditor.js`) now diffs the current editor text
  against the serialized DOM (`diff` from `@codemirror/merge`, as `applyRemoteContent()` already
  does) and dispatches only the changed ranges. Folds, decorations and the selection outside
  them stay. When nothing changed, it returns without dispatching, because no update (and no
  `editorReady` event) would follow. This also benefits the other callers (document rename,
  document actions, `xmleditor` plugin).
- The header fold toggle is now hidden, not just disabled, in annotation mode, which always keeps
  the header folded (`app/src/plugins/tei-tools.js`). For pure annotators it was already hidden.

## Tests

`tests/e2e/tests/unit-review.spec.js` checks that the header is still folded and the toggle
unchecked after the first mark, and that the toggle is hidden in annotation mode.
