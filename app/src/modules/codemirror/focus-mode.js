// @ts-check

/**
 * CodeMirror extension for the "distraction-free" focus mode of the XML editor.
 *
 * Exports:
 *   setFocusRangeEffect — StateEffect that sets (`{from, to}`) or clears (`null`) the focused range
 *   focusModeExtension — StateField that dims everything outside the focused range, plus its theme
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

/**
 * @param {FocusRange|null} range
 * @param {number} docLength
 * @returns {DecorationSet}
 */
function buildDecorations(range, docLength) {
  if (!range) return Decoration.none;
  const decorations = [];
  if (range.from > 0) decorations.push(dimmedMark.range(0, range.from));
  if (range.to < docLength) decorations.push(dimmedMark.range(range.to, docLength));
  return Decoration.set(decorations);
}

/**
 * Holds the focused range and maps it through document changes, so that
 * editing inside the focused node keeps it undimmed. Text inserted directly
 * before or after the range stays outside of it.
 * @type {StateField<FocusRange|null>}
 */
const focusRangeField = StateField.define({
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
    buildDecorations(state.field(field), state.doc.length))
});

const focusModeTheme = EditorView.baseTheme({
  '.cm-focus-dimmed': { opacity: '0.3' }
});

export const focusModeExtension = [focusRangeField, focusModeTheme];
