# Line breaks and indentation in the visual annotation mode

The visual annotation mode makes CodeMirror's editing commands read-only (`commandReadOnly()`), so text could not be reformatted there. Users need to reformat whitespace by hand without leaving the mode.

## Implementation

Rule: line breaks may be inserted or deleted and lines indented or outdented, but no text may be deleted or overwritten.

- `app/src/modules/codemirror/whitespace-keys.js`: `whitespaceKeys(isEditable)` binds Enter, Backspace, Tab and Shift-Tab with `Prec.highest`, ahead of the read-only commands. The commands dispatch their changes directly, since CodeMirror's own `insertNewlineAndIndent`, `indentMore` and `indentLess` refuse to run on a read-only state.
  - Enter (`insertNewlineKeepIndent`): inserts a line break plus the leading whitespace of the current line, copied verbatim. No indentation is inferred from the XML structure. A cursor inside the indentation copies only the part before it. Does nothing with a non-empty selection.
  - Backspace (`deleteWhitespaceBackward`): deletes the space, tab or line break before the cursor, or a selection of whitespace only; does nothing before other text.
  - Tab (`indentLines`): inserts one `indentUnit` at the start of each selected line.
  - Shift-Tab (`outdentLines`): removes a leading tab, or up to one unit's width of leading spaces.
- `xml-annotation.js` adds the extension to the annotation mode, enabled while `state.editorReadOnly` is false (like the annotation popup). For read-only documents the keys fall through and do nothing.
- The changes carry user events (`input`, `delete.backward`, `input.indent`, `delete.dedent`) and are undoable.

## Tests

- `tests/unit/js/whitespace-keys.test.js`: the three commands on a read-only state.
- `tests/e2e/tests/xml-annotation-undo.spec.js`: Enter, Backspace, Tab, Shift-Tab and undo in the visual mode; Backspace before text, Delete and typing stay blocked.
