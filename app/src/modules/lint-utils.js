/**
 * @registerModule
 */

/**
 * Helpers for contributing diagnostics from a plugin without clobbering the
 * diagnostics other plugins (e.g. tei-validation) put into the editor.
 *
 * CodeMirror keeps a single global diagnostic set: `setDiagnostics()` replaces
 * it wholesale. A plugin that owns its own diagnostics therefore has to merge
 * them into the current set and re-merge whenever something else replaces it.
 * This module exists so that frontend extensions (which cannot use ES imports)
 * can do that via `getDependency('lint-utils')`.
 *
 * Diagnostics are listed in the diagnostics drawer (see
 * `app/src/plugins/diagnostics-drawer.js`) instead of CodeMirror's lint panel.
 * A diagnostic may carry a `replacement` string: the text that replaces its
 * range when the user applies its fix from the drawer.
 *
 * @import { Diagnostic } from '@codemirror/lint'
 * @import { StateEffectType, Extension } from '@codemirror/state'
 * @import { EditorView, ViewUpdate } from '@codemirror/view'
 */

import { forEachDiagnostic, setDiagnostics, setDiagnosticsEffect, linter, lintGutter } from '@codemirror/lint';
import { EditorState, StateEffect, Facet } from '@codemirror/state';

/**
 * A diagnostic that may carry an automatically applicable fix.
 * @typedef {Diagnostic & {replacement?: string}} FixableDiagnostic
 */

/**
 * Effect asking the diagnostics drawer to expand, attached to a dispatch that
 * displays diagnostics the user just asked for.
 * @type {StateEffectType<null>}
 */
export const revealDiagnosticsEffect = StateEffect.define();

/**
 * Sources whose diagnostics are listed in the diagnostics drawer only, without a hover tooltip
 * or a marker in the lint gutter.
 * @type {Facet<string, Set<string>>}
 */
const drawerOnlySources = Facet.define({ combine: values => new Set(values) });

/**
 * @param {readonly Diagnostic[]} diagnostics
 * @param {EditorState} state
 * @returns {Diagnostic[]}
 */
const withoutDrawerOnly = (diagnostics, state) => {
  const hidden = state.facet(drawerOnlySources);
  return hidden.size ? diagnostics.filter(d => !hidden.has(d.source ?? '')) : [...diagnostics];
};

// one shared instance: lint gutter configurations with filters cannot be combined
const drawerOnlyConfig = [
  linter(null, { tooltipFilter: withoutDrawerOnly }),
  lintGutter({ markerFilter: withoutDrawerOnly, tooltipFilter: withoutDrawerOnly })
];

/**
 * Editor extension that lists the diagnostics of a source in the diagnostics drawer only: no hover
 * tooltip in the text and no lint gutter marker, for plugins that show the diagnostics' state and
 * actions in their own UI.
 * @param {string} source
 * @returns {Extension}
 */
export function drawerOnlyDiagnostics(source) {
  return [drawerOnlySources.of(source), drawerOnlyConfig];
}

/**
 * Editor extension that removes the diagnostics whose range a document change touches, in the
 * transaction making the change; the other diagnostics keep their (mapped) positions and fields.
 * Doing this within the transaction, instead of in a later dispatch, never removes diagnostics
 * that were added after the change. Like any replacement of the diagnostic set, it makes the
 * plugins owning diagnostics re-merge theirs (see {@link replacesDiagnostics}).
 * @returns {Extension}
 */
export function clearDiagnosticsOnChange() {
  return EditorState.transactionExtender.of(tr => {
    if (!tr.docChanged || tr.effects.some(e => e.is(setDiagnosticsEffect))) return null;
    /** @type {Diagnostic[]} */
    const kept = [];
    let removed = false;
    forEachDiagnostic(tr.startState, (d, from, to) => {
      if (tr.changes.touchesRange(from, to)) {
        removed = true;
      } else {
        kept.push({ ...d, from: tr.changes.mapPos(from), to: tr.changes.mapPos(to) });
      }
    });
    return removed ? { effects: setDiagnosticsEffect.of(kept) } : null;
  });
}

/** @type {Set<(dismissed: Diagnostic[]) => void>} */
const dismissListeners = new Set();

/**
 * Returns the diagnostics currently stored in the editor state.
 * @param {EditorState} state
 * @returns {Diagnostic[]}
 */
export function collectDiagnostics(state) {
  /** @type {Diagnostic[]} */
  const result = [];
  forEachDiagnostic(state, (d, from, to) => {
    result.push({ ...d, from, to });
  });
  return result;
}

/**
 * Returns the current diagnostics with all diagnostics of `source` replaced
 * by `own` (each tagged with `source`).
 * @param {EditorState} state
 * @param {string} source - Identifier marking diagnostics that belong to the caller
 * @param {Diagnostic[]} own
 * @returns {Diagnostic[]}
 */
export function mergeDiagnostics(state, source, own) {
  const foreign = collectDiagnostics(state).filter(d => d.source !== source);
  return [...foreign, ...own.map(d => ({ ...d, source }))];
}

/**
 * True if both lists contain the same diagnostics (source, severity, message, range, fix and action
 * names), in any order.
 * @param {FixableDiagnostic[]} a
 * @param {FixableDiagnostic[]} b
 * @returns {boolean}
 */
function sameDiagnostics(a, b) {
  if (a.length !== b.length) return false;
  /** @param {FixableDiagnostic} d */
  const key = d => JSON.stringify([d.source ?? '', d.severity, d.message, d.from, d.to, d.replacement ?? null, (d.actions ?? []).map(action => action.name)]);
  const keysA = a.map(key).sort();
  const keysB = b.map(key).sort();
  return keysA.every((k, i) => k === keysB[i]);
}

/**
 * Merges `own` into the view's diagnostics and dispatches the result, unless
 * that leaves them unchanged.
 * With `options.openPanel`, the diagnostics drawer is expanded even if the
 * focus is outside the XML editor; pass it only for results the user just
 * asked for.
 * @param {EditorView} view
 * @param {string} source
 * @param {Diagnostic[]} own
 * @param {{openPanel?: boolean}} [options]
 */
export function applyMergedDiagnostics(view, source, own, options = {}) {
  const merged = mergeDiagnostics(view.state, source, own);
  // a merge that changes nothing is not dispatched: every replacement of the diagnostic set makes
  // the plugins owning diagnostics re-merge theirs, so two plugins re-merging unconditionally would
  // otherwise replace the set in turn forever (and the drawer and lint gutter re-render each time)
  if (!options.openPanel && sameDiagnostics(collectDiagnostics(view.state), merged)) return;
  const spec = setDiagnostics(view.state, merged);
  if (options.openPanel) {
    spec.effects = [...[spec.effects ?? []].flat(), revealDiagnosticsEffect.of(null)];
  }
  view.dispatch(spec);
}

/**
 * True if the update contains a transaction that asked to reveal the
 * diagnostics (see {@link applyMergedDiagnostics}).
 * @param {Pick<ViewUpdate, 'transactions'>} update
 * @returns {boolean}
 */
export function revealsDiagnostics(update) {
  return update.transactions.some(tr => tr.effects.some(e => e.is(revealDiagnosticsEffect)));
}

/**
 * A key identifying a diagnostic across re-dispatches of the diagnostic set,
 * which create new diagnostic objects: source, severity, message and the
 * text it covers.
 * @param {EditorState} state
 * @param {Diagnostic} diagnostic - With positions in `state`
 * @returns {string}
 */
export function diagnosticKey(state, diagnostic) {
  const text = state.doc.sliceString(diagnostic.from, diagnostic.to);
  return [diagnostic.source ?? '', diagnostic.severity, diagnostic.message, text].join('\u0000');
}

/**
 * Registers a listener called with the diagnostics the user dismissed, so
 * that a plugin can forget those it owns and does not re-add them.
 * @param {(dismissed: Diagnostic[]) => void} listener
 * @returns {() => void} Function removing the listener
 */
export function addDismissListener(listener) {
  dismissListeners.add(listener);
  return () => dismissListeners.delete(listener);
}

/**
 * Removes the given diagnostics (matched by {@link diagnosticKey}) from the
 * view and notifies the dismiss listeners.
 * @param {EditorView} view
 * @param {Diagnostic[]} dismissed - With positions in the current state
 * @returns {void}
 */
export function dismissDiagnostics(view, dismissed) {
  if (!dismissed.length) return;
  const keys = new Set(dismissed.map(d => diagnosticKey(view.state, d)));
  const kept = collectDiagnostics(view.state).filter(d => !keys.has(diagnosticKey(view.state, d)));
  view.dispatch(setDiagnostics(view.state, kept));
  for (const listener of dismissListeners) listener(dismissed);
}

/**
 * Returns the changes that apply the fixes (`replacement`) of the given
 * diagnostics, sorted by position. Diagnostics without a fix, and those
 * overlapping an earlier fix, are skipped.
 * @param {FixableDiagnostic[]} diagnostics - With positions in the current state
 * @returns {{changes: {from: number, to: number, insert: string}[], applied: FixableDiagnostic[]}}
 */
export function fixChanges(diagnostics) {
  const fixable = diagnostics
    .filter(d => typeof d.replacement === 'string')
    .sort((a, b) => a.from - b.from || a.to - b.to);
  /** @type {{from: number, to: number, insert: string}[]} */
  const changes = [];
  /** @type {FixableDiagnostic[]} */
  const applied = [];
  let end = -1;
  for (const d of fixable) {
    if (d.from < end) continue;
    changes.push({ from: d.from, to: d.to, insert: /** @type {string} */ (d.replacement) });
    applied.push(d);
    end = d.to;
  }
  return { changes, applied };
}

/**
 * True if the update contains a transaction that replaced the diagnostic set
 * (e.g. a validation run finished).
 * @param {Pick<ViewUpdate, 'transactions'>} update
 * @returns {boolean}
 */
export function replacesDiagnostics(update) {
  return update.transactions.some(tr => tr.effects.some(e => e.is(setDiagnosticsEffect)));
}
