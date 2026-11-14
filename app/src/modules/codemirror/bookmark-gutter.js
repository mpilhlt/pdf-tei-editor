// @ts-check

/**
 * CodeMirror gutter for bookmarks: a bookmark icon on the first line of each bookmarked element,
 * with the bookmark titles as tooltip and a count when a line holds several bookmarks.
 *
 * The markers are computed outside CodeMirror (by the bookmarks plugin) and set with
 * {@link setBookmarkMarkersEffect}; between two updates they are mapped through document changes.
 *
 * @import { EditorView, BlockInfo } from '@codemirror/view'
 * @import { Text, Extension } from '@codemirror/state'
 */

import { StateField, StateEffect, RangeSet, RangeSetBuilder, Prec } from '@codemirror/state';
import { EditorView as View, gutter, GutterMarker } from '@codemirror/view';

/**
 * @typedef {object} BookmarkLineMark
 * @property {number} line - 1-based line number
 * @property {number} count - Number of bookmarks on the line
 * @property {string} title - Tooltip text
 */

const BOOKMARK = 'M2 2v13.5a.5.5 0 0 0 .74.439L8 13.069l5.26 2.87A.5.5 0 0 0 14 15.5V2a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2';

class BookmarkMarker extends GutterMarker {
  /**
   * @param {boolean} spacer - Only sets the gutter width
   * @param {number} count
   * @param {string} title
   */
  constructor(spacer, count, title) {
    super();
    this.spacer = spacer;
    this.count = count;
    this.title = title;
  }

  /** @param {GutterMarker} other */
  eq(other) {
    return other instanceof BookmarkMarker && other.spacer === this.spacer && other.count === this.count && other.title === this.title;
  }

  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-bm-marker';
    if (this.spacer) return el;
    el.dataset.testid = 'bookmark-gutter-marker';
    el.innerHTML = `<svg viewBox="0 0 16 16" width="10" height="11" fill="currentColor" aria-hidden="true"><path d="${BOOKMARK}"/></svg>`;
    if (this.count > 1) el.dataset.count = String(this.count);
    if (this.title) el.title = this.title;
    return el;
  }
}

const spacer = new BookmarkMarker(true, 0, '');

/** @type {import('@codemirror/state').StateEffectType<RangeSet<GutterMarker>>} */
export const setBookmarkMarkersEffect = StateEffect.define();

const markerField = StateField.define({
  create: () => /** @type {RangeSet<GutterMarker>} */ (RangeSet.empty),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setBookmarkMarkersEffect)) return effect.value;
    }
    return value.map(tr.changes);
  }
});

/**
 * Builds the marker set for the given lines.
 * @param {Text} doc
 * @param {BookmarkLineMark[]} marks
 * @returns {RangeSet<GutterMarker>}
 */
export function buildBookmarkMarkers(doc, marks) {
  const builder = new RangeSetBuilder();
  for (const mark of [...marks].sort((a, b) => a.line - b.line)) {
    if (mark.line < 1 || mark.line > doc.lines) continue;
    const from = doc.line(mark.line).from;
    builder.add(from, from, new BookmarkMarker(false, mark.count, mark.title));
  }
  return /** @type {RangeSet<GutterMarker>} */ (builder.finish());
}

const theme = View.baseTheme({
  '.cm-bookmark-gutter .cm-gutterElement': { cursor: 'pointer', display: 'flex', alignItems: 'center', paddingLeft: '3px' },
  '.cm-bookmark-gutter': { minWidth: '15px' },
  '.cm-bm-marker': { position: 'relative', width: '11px', lineHeight: '0', color: '#c2410c' },
  '.cm-bm-marker[data-count]::after': {
    content: 'attr(data-count)', position: 'absolute', top: '-4px', right: '-3px', fontSize: '8px', lineHeight: '1',
    fontWeight: '700'
  }
});

/**
 * The gutter extension. It is placed with the unit comment gutter, before the line numbers.
 * @param {(view: EditorView, line: BlockInfo) => boolean} onClick
 * @returns {Extension}
 */
export function bookmarkGutter(onClick) {
  return [
    markerField,
    Prec.high(gutter({
      class: 'cm-bookmark-gutter',
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
