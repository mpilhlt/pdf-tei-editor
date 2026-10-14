// @ts-check

/**
 * CodeMirror extension for the "distraction-free" focus mode of the XML editor.
 *
 * Exports:
 *   setFocusRangeEffect — StateEffect that sets (`{from, to}`) or clears (`null`) the focused range
 *   focusRangeField — the StateField holding the focused range (`FocusRange|null`)
 *   focusActionsFacet — Facet of {@link FocusAction}s shown as buttons in the bottom right corner of
 *                       the focused range
 *   focusModeExtension — StateField that dims everything outside the focused range and adds spacing
 *                        around it, plus its theme
 */

import { StateField, StateEffect, Facet } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

/**
 * @import { DecorationSet } from '@codemirror/view'
 */

/**
 * @typedef {object} FocusRange
 * @property {number} from - Start offset of the focused range
 * @property {number} to - End offset of the focused range
 */

/**
 * @typedef {object} FocusAction
 * @property {string} label - Button text
 * @property {string} [title] - Button tooltip
 * @property {(view: EditorView) => void} run - Called when the button is clicked
 */

/** @type {StateEffect<FocusRange|null>} */
export const setFocusRangeEffect = StateEffect.define();

/**
 * Actions shown as buttons in the spacing below the focused range.
 * @type {Facet<FocusAction[], FocusAction[]>}
 */
export const focusActionsFacet = Facet.define({
  combine: values => values.flat()
});

/**
 * Renders the focus actions as buttons styled like the lint panel's diagnostic actions,
 * positioned in the bottom right corner of the last focused line.
 */
class FocusActionsWidget extends WidgetType {
  /** @param {FocusAction[]} actions */
  constructor(actions) {
    super();
    this.actions = actions;
  }

  /** @param {FocusActionsWidget} other */
  eq(other) {
    return other.actions.length === this.actions.length
      && other.actions.every((action, i) => action === this.actions[i]);
  }

  /** @param {EditorView} view */
  toDOM(view) {
    const wrapper = document.createElement('span');
    wrapper.className = 'cm-focus-actions';
    for (const action of this.actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cm-focus-action';
      button.textContent = action.label;
      if (action.title) button.title = action.title;
      // keep the cursor where it is
      button.addEventListener('mousedown', evt => evt.preventDefault());
      button.addEventListener('click', evt => {
        evt.preventDefault();
        action.run(view);
      });
      wrapper.appendChild(button);
    }
    return wrapper;
  }

  ignoreEvent() {
    return true;
  }
}

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
  const actions = state.facet(focusActionsFacet);
  if (actions.length) {
    decorations.push(Decoration.widget({ widget: new FocusActionsWidget(actions), side: 1 }).range(last.to));
  }
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
  provide: field => EditorView.decorations.compute([field, 'doc', focusActionsFacet], state =>
    buildDecorations(state.field(field), state))
});

const focusModeTheme = EditorView.baseTheme({
  '.cm-focus-dimmed': { opacity: '0.3' },
  '.cm-focus-first': { paddingTop: '1.5em' },
  '.cm-focus-last': { paddingBottom: '1.5em', position: 'relative' },
  '.cm-focus-actions': { position: 'absolute', right: '4px', bottom: '2px', display: 'flex', gap: '4px' },
  '.cm-focus-action': {
    font: 'inherit',
    fontSize: '85%',
    lineHeight: '1.3',
    border: 'none',
    padding: '1px 6px',
    backgroundColor: '#444',
    color: 'white',
    borderRadius: '3px',
    cursor: 'pointer'
  }
});

export const focusModeExtension = [focusRangeField, focusModeTheme];
