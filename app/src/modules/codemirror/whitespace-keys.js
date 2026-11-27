/**
 * Whitespace editing for an editor whose editing commands are read-only (see
 * `command-read-only.js`), such as the visual annotation mode: Enter inserts a line break and
 * Tab/Shift-Tab indent and outdent the selected lines, so that users can reformat the text by
 * hand while all other keys stay non-editing.
 *
 * The commands dispatch their changes directly instead of going through CodeMirror's own editing
 * commands, which refuse to run on a read-only state.
 *
 * @import { Extension, EditorState, Transaction, ChangeSpec, Line } from '@codemirror/state'
 * @import { KeyBinding } from '@codemirror/view'
 */

import { EditorSelection, Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentUnit, getIndentUnit } from '@codemirror/language';

/**
 * @typedef {(target: {state: EditorState, dispatch: (tr: Transaction) => void}) => boolean} StateCommand
 */

/**
 * Replaces each selection range with a line break followed by the indentation of the line the
 * range starts on, copied verbatim (spaces and tabs as they are). If the range starts inside the
 * indentation, only the part of it before the range is copied.
 * @type {StateCommand}
 */
export function insertNewlineKeepIndent({ state, dispatch }) {
  const tr = state.update(state.changeByRange(range => {
    const line = state.doc.lineAt(range.from);
    const indent = /^[ \t]*/.exec(line.text)?.[0] ?? '';
    const copied = indent.slice(0, range.from - line.from);
    const insert = state.lineBreak + copied;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length)
    };
  }), { scrollIntoView: true, userEvent: 'input' });
  dispatch(tr);
  return true;
}

/**
 * The lines touched by the selection, each line once.
 * @param {EditorState} state
 * @returns {Line[]}
 */
function selectedLines(state) {
  /** @type {Map<number, Line>} */
  const lines = new Map();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    // A range that ends at the start of a line does not include that line
    if (last > first && state.doc.line(last).from === range.to) last--;
    for (let n = first; n <= last; n++) lines.set(n, state.doc.line(n));
  }
  return [...lines.values()];
}

/**
 * Inserts one indentation unit (the editor's `indentUnit`) at the start of each selected line.
 * @type {StateCommand}
 */
export function indentLines({ state, dispatch }) {
  const unit = state.facet(indentUnit);
  /** @type {ChangeSpec[]} */
  const changes = selectedLines(state).map(line => ({ from: line.from, insert: unit }));
  dispatch(state.update({ changes, userEvent: 'input.indent' }));
  return true;
}

/**
 * Removes up to one indentation unit of leading whitespace from each selected line: a leading tab,
 * or as many leading spaces as the unit is wide.
 * @type {StateCommand}
 */
export function outdentLines({ state, dispatch }) {
  const width = getIndentUnit(state);
  /** @type {ChangeSpec[]} */
  const changes = [];
  for (const line of selectedLines(state)) {
    const text = line.text;
    let remove = 0;
    if (text.startsWith('\t')) {
      remove = 1;
    } else {
      while (remove < width && text[remove] === ' ') remove++;
    }
    if (remove > 0) changes.push({ from: line.from, to: line.from + remove });
  }
  if (changes.length === 0) return true;
  dispatch(state.update({ changes, userEvent: 'delete.dedent' }));
  return true;
}

/**
 * The key bindings Enter, Tab and Shift-Tab, with the highest precedence so that they run before
 * the read-only editing commands. They do nothing (and let the key through) while
 * `isEditable()` returns false, e.g. for a document the user may not edit.
 * @param {() => boolean} isEditable
 * @returns {Extension}
 */
export function whitespaceKeys(isEditable) {
  /**
   * @param {StateCommand} command
   * @returns {KeyBinding['run']}
   */
  const guarded = command => view => isEditable() && command({ state: view.state, dispatch: tr => view.dispatch(tr) });
  return Prec.highest(keymap.of([
    { key: 'Enter', run: guarded(insertNewlineKeepIndent) },
    { key: 'Tab', run: guarded(indentLines), shift: guarded(outdentLines) }
  ]));
}
