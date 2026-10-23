// @ts-check

/**
 * CodeMirror gutter for unit review marking: a thin status strip left of the line numbers.
 *
 * The markers are computed outside CodeMirror (by the unit-review plugin) and set with
 * {@link setUnitReviewMarkersEffect}; between two updates they are mapped through document changes.
 *
 * Exports:
 *   setUnitReviewMarkersEffect — StateEffect replacing all markers
 *   buildUnitReviewMarkers — builds the marker set from per-line states
 *   unitReviewGutter — the gutter extension (state field, gutter and theme)
 *
 * @import { EditorView, BlockInfo } from '@codemirror/view'
 * @import { Text, Extension } from '@codemirror/state'
 */

import { StateField, StateEffect, RangeSet, RangeSetBuilder, Prec } from '@codemirror/state';
import { EditorView as View, gutter, GutterMarker } from '@codemirror/view';

/**
 * Visual state of one line
 * @typedef {'ok'|'not-ok'|'disputed'|'stale'|'uncertain'|'drag'} LineMarkState
 */

/**
 * @typedef {object} LineMark
 * @property {number} line - 1-based line number
 * @property {LineMarkState} state
 * @property {string} title - Tooltip text
 */

class StripMarker extends GutterMarker {
  /**
   * @param {LineMarkState} state
   * @param {string} title
   */
  constructor(state, title) {
    super();
    this.state = state;
    this.title = title;
  }

  /** @param {GutterMarker} other */
  eq(other) {
    return other instanceof StripMarker && other.state === this.state && other.title === this.title;
  }

  toDOM() {
    const el = document.createElement('div');
    el.className = `cm-ur-strip cm-ur-${this.state}`;
    if (this.title) el.title = this.title;
    return el;
  }
}

// sets the gutter width only, never shown
const spacer = new StripMarker(/** @type {LineMarkState} */ ('spacer'), '');

/** @type {import('@codemirror/state').StateEffectType<RangeSet<GutterMarker>>} */
export const setUnitReviewMarkersEffect = StateEffect.define();

const markerField = StateField.define({
  create: () => /** @type {RangeSet<GutterMarker>} */ (RangeSet.empty),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setUnitReviewMarkersEffect)) return effect.value;
    }
    return value.map(tr.changes);
  }
});

/**
 * Builds the marker set for the given line states.
 * @param {Text} doc
 * @param {LineMark[]} marks
 * @returns {RangeSet<GutterMarker>}
 */
export function buildUnitReviewMarkers(doc, marks) {
  const builder = new RangeSetBuilder();
  for (const mark of [...marks].sort((a, b) => a.line - b.line)) {
    if (mark.line < 1 || mark.line > doc.lines) continue;
    builder.add(doc.line(mark.line).from, doc.line(mark.line).from, new StripMarker(mark.state, mark.title));
  }
  return /** @type {RangeSet<GutterMarker>} */ (builder.finish());
}

const theme = View.baseTheme({
  '.cm-unit-review-gutter .cm-gutterElement': { padding: '0 2px 0 0', cursor: 'pointer' },
  '.cm-unit-review-gutter': { minWidth: '7px' },
  '.cm-ur-strip': { width: '4px', height: '100%' },
  '.cm-ur-ok': { background: '#2f9e57' },
  '.cm-ur-not-ok': { background: '#d64545' },
  '.cm-ur-disputed': { background: 'linear-gradient(180deg, #d64545 0 50%, #2f9e57 50% 100%)' },
  '.cm-ur-stale': { background: 'repeating-linear-gradient(180deg, #8a8f98 0 3px, transparent 3px 6px)' },
  '.cm-ur-uncertain': { background: '#e0a020' },
  '.cm-ur-drag': { background: '#0b6bcb' }
});

/**
 * Handlers for mouse events on the strip
 * @typedef {object} UnitReviewGutterHandlers
 * @property {(view: EditorView, line: BlockInfo, event: MouseEvent) => boolean} mousedown
 * @property {(view: EditorView, line: BlockInfo, event: MouseEvent) => boolean} mouseover
 */

/**
 * The gutter extension. It is placed before all other gutters.
 * @param {UnitReviewGutterHandlers} handlers
 * @returns {Extension}
 */
export function unitReviewGutter(handlers) {
  return [
    markerField,
    Prec.highest(gutter({
      class: 'cm-unit-review-gutter',
      markers: view => view.state.field(markerField),
      initialSpacer: () => spacer,
      domEventHandlers: {
        mousedown: (view, line, event) => handlers.mousedown(view, line, /** @type {MouseEvent} */ (event)),
        mouseover: (view, line, event) => handlers.mouseover(view, line, /** @type {MouseEvent} */ (event))
      }
    })),
    theme
  ];
}
