// @ts-check

/**
 * A gutter shared by several sources of line markers, such as unit comments and bookmarks. The
 * markers of all sources on a line are shown next to each other, right-aligned towards the line
 * numbers, so that a line with a single marker has it at the same place whatever its source.
 *
 * A source contributes a state field with its markers through {@link lineMarkerSource}. The gutter
 * is part of the editor while at least one source is configured. A click on a marker goes to the
 * source that owns it (its DOM element carries `data-marker-source`); a click elsewhere on the
 * line goes to the first source with a marker on the line.
 *
 * @import { EditorView, BlockInfo } from '@codemirror/view'
 * @import { StateField, Extension } from '@codemirror/state'
 */

import { Facet, RangeSet, Prec } from '@codemirror/state';
import { EditorView as View, gutter, GutterMarker } from '@codemirror/view';

/**
 * A source of line markers
 * @typedef {object} LineMarkerSourceSpec
 * @property {string} id - Set as `data-marker-source` on the source's marker elements
 * @property {StateField<RangeSet<GutterMarker>>} field - The source's markers
 * @property {(view: EditorView, line: BlockInfo) => boolean} [onClick]
 */

/** @type {Facet<LineMarkerSourceSpec, readonly LineMarkerSourceSpec[]>} */
const lineMarkerSources = Facet.define();

class SpacerMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-line-marker-spacer';
    return el;
  }
}

/**
 * Whether a marker set has a marker at the start of a line.
 * @param {RangeSet<GutterMarker>} set
 * @param {number} from
 * @returns {boolean}
 */
function hasMarkerAt(set, from) {
  let found = false;
  set.between(from, from, (start) => {
    if (start === from) {
      found = true;
      return false;
    }
  });
  return found;
}

/**
 * The marker sets of the configured sources, in the order of their configuration.
 * @param {EditorView} view
 * @returns {RangeSet<GutterMarker>[]}
 */
function markerSets(view) {
  return view.state.facet(lineMarkerSources).map(source => view.state.field(source.field, false) ?? RangeSet.empty);
}

const theme = View.baseTheme({
  '.cm-line-marker-gutter .cm-gutterElement': {
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '3px',
    padding: '0 2px 0 3px'
  },
  '.cm-line-marker-spacer': { width: '12px' }
});

// one instance, so that CodeMirror adds the gutter once however many sources are configured
const sharedGutter = [
  Prec.high(gutter({
    class: 'cm-line-marker-gutter',
    markers: view => markerSets(view),
    initialSpacer: () => new SpacerMarker(),
    domEventHandlers: {
      mousedown: (view, line, event) => {
        if (/** @type {MouseEvent} */ (event).button !== 0) return false;
        const sources = view.state.facet(lineMarkerSources);
        const target = /** @type {HTMLElement|null} */ (/** @type {Element} */ (event.target)?.closest?.('[data-marker-source]'));
        const source = sources.find(s => s.id === target?.dataset.markerSource)
          ?? sources.find(s => hasMarkerAt(view.state.field(s.field, false) ?? RangeSet.empty, line.from));
        if (!source?.onClick) return false;
        event.preventDefault();
        return source.onClick(view, line);
      }
    }
  })),
  theme
];

/**
 * Adds a source of markers to the shared line marker gutter (and the gutter if it is not there yet).
 * @param {LineMarkerSourceSpec} spec
 * @returns {Extension}
 */
export function lineMarkerSource(spec) {
  return [spec.field, lineMarkerSources.of(spec), sharedGutter];
}
