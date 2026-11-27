/**
 * Whitespace editing for an editor whose editing commands are read-only (see
 * `command-read-only.js`), such as the visual annotation mode: Enter inserts a line break,
 * Backspace deletes whitespace and Tab/Shift-Tab indent and outdent the selected lines, so that
 * users can reformat the text by hand. No other text is deleted or overwritten, and all other keys
 * stay non-editing.
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
 * Inserts a line break at each cursor, followed by the indentation of the cursor's line, copied
 * verbatim (spaces and tabs as they are). If the cursor is inside the indentation, only the part
 * of it before the cursor is copied. Does nothing if a range is not empty, since no text must be
 * overwritten.
 * @type {StateCommand}
 */
export function insertNewlineKeepIndent({ state, dispatch }) {
  if (state.selection.ranges.some(range => !range.empty)) return true;
  const tr = state.update(state.changeByRange(range => {
    const line = state.doc.lineAt(range.from);
    const indent = /^[ \t]*/.exec(line.text)?.[0] ?? '';
    const copied = indent.slice(0, range.from - line.from);
    const insert = state.lineBreak + copied;
    return {
      changes: { from: range.from, insert },
      range: EditorSelection.cursor(range.from + insert.length)
    };
  }), { scrollIntoView: true, userEvent: 'input' });
  dispatch(tr);
  return true;
}

/** Whitespace that {@link deleteWhitespaceBackward} may delete: spaces, tabs and line breaks. */
const WHITESPACE = /^[ \t\r\n]+$/;

/**
 * Deletes the whitespace character (space, tab or line break) before each cursor, or each
 * selected range if it consists of whitespace only. Does nothing if any of them is other text.
 * @type {StateCommand}
 */
export function deleteWhitespaceBackward({ state, dispatch }) {
  /** @type {ChangeSpec[]} */
  const deletions = [];
  for (const range of state.selection.ranges) {
    let from = range.from;
    if (range.empty) {
      if (from === 0) continue;
      const line = state.doc.lineAt(from);
      // a line break before the cursor counts as one character, also if it is "\r\n"
      from = from === line.from ? state.doc.line(line.number - 1).to : from - 1;
    }
    if (!WHITESPACE.test(state.doc.sliceString(from, range.to))) return true;
    deletions.push({ from, to: range.to });
  }
  if (deletions.length === 0) return true;
  // the selection is mapped through the deletions, which collapses each range at its start
  dispatch(state.update({ changes: deletions, scrollIntoView: true, userEvent: 'delete.backward' }));
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
 * The key bindings Enter, Backspace, Tab and Shift-Tab, with the highest precedence so that they run before
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
    { key: 'Backspace', run: guarded(deleteWhitespaceBackward) },
    { key: 'Tab', run: guarded(indentLines), shift: guarded(outdentLines) }
  ]));
}
