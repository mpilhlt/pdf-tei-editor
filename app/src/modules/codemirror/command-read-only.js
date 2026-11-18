/**
 * Makes the editor read-only for CodeMirror's editing commands, except for undo and redo.
 *
 * `EditorState.readOnly` stops the built-in editing commands (Enter, Backspace, cut, paste) that
 * run on key presses, but also CodeMirror's undo and redo commands, which return `false` on a
 * read-only state. Changes made programmatically, e.g. by the visual annotation mode, could
 * then not be undone. This extension sets the facet from a state field that
 * {@link runIgnoringCommandReadOnly} lifts while it runs a history command, and binds the history
 * keys (Mod-z, Mod-y, Mod-Shift-z) with the highest precedence so that they get past the facet.
 *
 * @import { Extension } from '@codemirror/state'
 * @import { Command, EditorView } from '@codemirror/view'
 */

import { EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { historyKeymap, undo, redo } from '@codemirror/commands';

/** Lifts (true) or restores (false) the read-only state of the editing commands. */
const liftEffect = StateEffect.define({ /** @param {boolean} value */ map: value => value });

/** True while {@link runIgnoringCommandReadOnly} runs a command. */
const liftedField = StateField.define({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(liftEffect)) value = effect.value;
    return value;
  },
  provide: field => EditorState.readOnly.from(field, lifted => !lifted)
});

/**
 * Runs a command with the read-only state of {@link commandReadOnly} lifted. Without that
 * extension, or when the state is not read-only, it runs the command as it is.
 * @param {EditorView} view
 * @param {Command} command
 * @returns {boolean} Whether the command ran
 */
export function runIgnoringCommandReadOnly(view, command) {
  if (!view.state.readOnly || view.state.field(liftedField, false) === undefined) {
    return command(view);
  }
  view.dispatch({ effects: liftEffect.of(true) });
  try {
    return command(view);
  } finally {
    view.dispatch({ effects: liftEffect.of(false) });
  }
}

/**
 * Undoes the last change, also if the editing commands are read-only (see {@link commandReadOnly}).
 * @param {EditorView} view
 * @returns {boolean} Whether there was a change to undo
 */
export function undoIgnoringCommandReadOnly(view) {
  return runIgnoringCommandReadOnly(view, undo);
}

/**
 * Redoes the last undone change, also if the editing commands are read-only (see {@link commandReadOnly}).
 * @param {EditorView} view
 * @returns {boolean} Whether there was a change to redo
 */
export function redoIgnoringCommandReadOnly(view) {
  return runIgnoringCommandReadOnly(view, redo);
}

/**
 * The extension: CodeMirror's editing commands are read-only, its history commands are not.
 * @returns {Extension}
 */
export function commandReadOnly() {
  return [
    liftedField,
    Prec.highest(keymap.of(historyKeymap.map(binding => ({
      ...binding,
      run: binding.run && ((/** @type {EditorView} */ view) => runIgnoringCommandReadOnly(view, /** @type {Command} */ (binding.run)))
    }))))
  ];
}
