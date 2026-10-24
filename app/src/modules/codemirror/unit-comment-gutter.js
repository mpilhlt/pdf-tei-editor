// @ts-check

/**
 * CodeMirror gutter for unit comments: a speech bubble on the first line of each commented
 * element, blue while a thread is open, grey when all threads of the line are resolved.
 *
 * The markers are computed outside CodeMirror (by the unit-comments plugin) and set with
 * {@link setUnitCommentMarkersEffect}; between two updates they are mapped through document changes.
 *
 * @import { EditorView, BlockInfo } from '@codemirror/view'
 * @import { Text, Extension } from '@codemirror/state'
 */

import { StateField, StateEffect, RangeSet, RangeSetBuilder, Prec } from '@codemirror/state';
import { EditorView as View, gutter, GutterMarker } from '@codemirror/view';

/**
 * @typedef {object} CommentLineMark
 * @property {number} line - 1-based line number
 * @property {'open'|'resolved'} state
 * @property {number} count - Number of threads on the line
 * @property {string} title - Tooltip text
 */

const BUBBLE = 'M2 0a2 2 0 0 0-2 2v12.793a.5.5 0 0 0 .854.353l2.853-2.853A1 1 0 0 1 4.414 12H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2z';

class BubbleMarker extends GutterMarker {
  /**
   * @param {'open'|'resolved'|'spacer'} state
   * @param {number} count
   * @param {string} title
   */
  constructor(state, count, title) {
    super();
    this.state = state;
    this.count = count;
    this.title = title;
  }

  /** @param {GutterMarker} other */
  eq(other) {
    return other instanceof BubbleMarker && other.state === this.state && other.count === this.count && other.title === this.title;
  }

  toDOM() {
    const el = document.createElement('div');
    el.className = `cm-uc-bubble cm-uc-${this.state}`;
    if (this.state === 'spacer') return el;
    el.innerHTML = `<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="${BUBBLE}"/></svg>`;
    if (this.count > 1) el.dataset.count = String(this.count);
    if (this.title) el.title = this.title;
    return el;
  }
}

// sets the gutter width only, never shown
const spacer = new BubbleMarker('spacer', 0, '');

/** @type {import('@codemirror/state').StateEffectType<RangeSet<GutterMarker>>} */
export const setUnitCommentMarkersEffect = StateEffect.define();

const markerField = StateField.define({
  create: () => /** @type {RangeSet<GutterMarker>} */ (RangeSet.empty),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setUnitCommentMarkersEffect)) return effect.value;
    }
    return value.map(tr.changes);
  }
});

/**
 * Builds the marker set for the given lines.
 * @param {Text} doc
 * @param {CommentLineMark[]} marks
 * @returns {RangeSet<GutterMarker>}
 */
export function buildUnitCommentMarkers(doc, marks) {
  const builder = new RangeSetBuilder();
  for (const mark of [...marks].sort((a, b) => a.line - b.line)) {
    if (mark.line < 1 || mark.line > doc.lines) continue;
    const from = doc.line(mark.line).from;
    builder.add(from, from, new BubbleMarker(mark.state, mark.count, mark.title));
  }
  return /** @type {RangeSet<GutterMarker>} */ (builder.finish());
}

const theme = View.baseTheme({
  '.cm-unit-comment-gutter .cm-gutterElement': { cursor: 'pointer', display: 'flex', alignItems: 'center' },
  '.cm-unit-comment-gutter': { minWidth: '14px' },
  '.cm-uc-bubble': { position: 'relative', width: '12px', lineHeight: '0' },
  '.cm-uc-open': { color: '#0b6bcb' },
  '.cm-uc-resolved': { color: '#a0a6ae' },
  '.cm-uc-bubble[data-count]::after': {
    content: 'attr(data-count)', position: 'absolute', top: '-4px', right: '-3px', fontSize: '8px', lineHeight: '1',
    fontWeight: '700'
  }
});

/**
 * The gutter extension. It is placed after the unit review strip, before the line numbers.
 * @param {(view: EditorView, line: BlockInfo) => boolean} onClick
 * @returns {Extension}
 */
export function unitCommentGutter(onClick) {
  return [
    markerField,
    Prec.high(gutter({
      class: 'cm-unit-comment-gutter',
      markers: view => view.state.field(markerField),
      initialSpacer: () => spacer,
      domEventHandlers: {
        mousedown: (view, line, event) => {
          if (/** @type {MouseEvent} */ (event).button !== 0) return false;
          event.preventDefault();
          return onClick(view, line);
        }
      }
    })),
    theme
  ];
}
