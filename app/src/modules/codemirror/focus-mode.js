// @ts-check

/**
 * CodeMirror extension for the "distraction-free" focus mode of the XML editor.
 *
 * Exports:
 *   setFocusRangeEffect — StateEffect that sets (`{from, to}`) or clears (`null`) the focused range
 *   focusRangeField — the StateField holding the focused range (`FocusRange|null`)
 *   focusModeExtension — StateField that dims everything outside the focused range and adds spacing
 *                        around it, plus its theme
 */

import { StateField, StateEffect } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

/**
 * @import { DecorationSet } from '@codemirror/view'
 */

/**
 * @typedef {object} FocusRange
 * @property {number} from - Start offset of the focused range
 * @property {number} to - End offset of the focused range
 */

/** @type {StateEffect<FocusRange|null>} */
export const setFocusRangeEffect = StateEffect.define();

const dimmedMark = Decoration.mark({ class: 'cm-focus-dimmed' });
const dimmedLine = Decoration.line({ class: 'cm-focus-dimmed' });
const firstLine = Decoration.line({ class: 'cm-focus-first' });
const lastLine = Decoration.line({ class: 'cm-focus-last' });

/**
 * Dims all lines outside the focused range with line decorations (these also cover widgets such
 * as annotation badges, which mark decorations do not reliably reach), dims the text before and
 * after the range on the lines it starts and ends on with mark decorations, and flags the first
 * and last line of the range so that they can be given extra spacing.
 * @param {import('@codemirror/state').EditorState} state
 * @param {FocusRange|null} range
 * @returns {DecorationSet}
 */
function buildDecorations(range, state) {
  if (!range) return Decoration.none;
  const { doc } = state;
  const first = doc.lineAt(range.from);
  const last = doc.lineAt(Math.min(range.to, doc.length));
  const decorations = [];
  for (let n = 1; n < first.number; n++) decorations.push(dimmedLine.range(doc.line(n).from));
  for (let n = last.number + 1; n <= doc.lines; n++) decorations.push(dimmedLine.range(doc.line(n).from));
  if (range.from > first.from) decorations.push(dimmedMark.range(first.from, range.from));
  if (range.to < last.to) decorations.push(dimmedMark.range(range.to, last.to));
  decorations.push(firstLine.range(first.from));
  decorations.push(lastLine.range(last.from));
  return Decoration.set(decorations, true);
}

/**
 * Holds the focused range and maps it through document changes, so that
 * editing inside the focused node keeps it undimmed. Text inserted directly
 * before or after the range stays outside of it.
 * @type {StateField<FocusRange|null>}
 */
export const focusRangeField = StateField.define({
  create: () => null,
  update(range, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFocusRangeEffect)) return effect.value;
    }
    if (range && tr.docChanged) {
      const from = tr.changes.mapPos(range.from, 1);
      const to = tr.changes.mapPos(range.to, -1);
      return to > from ? { from, to } : null;
    }
    return range;
  },
  provide: field => EditorView.decorations.compute([field, 'doc'], state =>
    buildDecorations(state.field(field), state))
});

const focusModeTheme = EditorView.baseTheme({
  '.cm-focus-dimmed': { opacity: '0.3' },
  '.cm-focus-first': { paddingTop: '1.5em' },
  '.cm-focus-last': { paddingBottom: '1.5em' }
});

export const focusModeExtension = [focusRangeField, focusModeTheme];
