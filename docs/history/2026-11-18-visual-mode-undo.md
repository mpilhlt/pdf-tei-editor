# Undo and redo in the visual annotation mode (#824)

## Problem

In the visual annotation mode, the Undo button and Ctrl+Z did nothing.

The mode adds `EditorState.readOnly.of(true)` to the editor, so that key presses do not run CodeMirror's built-in editing commands (Enter, Backspace, cut, paste) while the content is focusable for keyboard shortcuts. CodeMirror's `undo` and `redo` commands also check `state.readOnly` and return `false` on a read-only state, so neither the toolbar buttons (which call `undo(view)`) nor the history keymap could undo the annotations, which the mode adds programmatically.

## Fix

`app/src/modules/codemirror/command-read-only.js` provides `commandReadOnly()`, which the visual mode uses in place of the plain facet:

- `EditorState.readOnly` is computed from a state field. `runIgnoringCommandReadOnly(view, command)` lifts it with an effect while it runs a command and restores it afterwards; both effect-only transactions leave the history untouched.
- The history keymap (Mod-z, Mod-y, Mod-Shift-z) is bound again with `Prec.highest`, running its commands through `runIgnoringCommandReadOnly`.
- The XML editor's Undo and Redo buttons call `undoIgnoringCommandReadOnly` / `redoIgnoringCommandReadOnly`, which behave like `undo` / `redo` when the extension is not active.

The other editing commands stay read-only. Undo and redo are still subject to the editor's own read-only filter and edit guards (`XMLEditor.setReadOnly`, `setEditGuardXpath`), which let them pass.

## Test

`tests/e2e/tests/xml-annotation-undo.spec.js` adds an annotation in the visual mode, undoes and redoes it with the buttons and the keyboard, and checks that Backspace, Delete and Enter still change nothing.
