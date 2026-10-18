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
 * @import { EditorState, StateEffectType } from '@codemirror/state'
 * @import { EditorView, ViewUpdate } from '@codemirror/view'
 */

import { forEachDiagnostic, setDiagnostics, setDiagnosticsEffect } from '@codemirror/lint';
import { StateEffect } from '@codemirror/state';

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
 * Merges `own` into the view's diagnostics and dispatches the result.
 * With `options.openPanel`, the diagnostics drawer is expanded even if the
 * focus is outside the XML editor; pass it only for results the user just
 * asked for.
 * @param {EditorView} view
 * @param {string} source
 * @param {Diagnostic[]} own
 * @param {{openPanel?: boolean}} [options]
 */
export function applyMergedDiagnostics(view, source, own, options = {}) {
  const spec = setDiagnostics(view.state, mergeDiagnostics(view.state, source, own));
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
