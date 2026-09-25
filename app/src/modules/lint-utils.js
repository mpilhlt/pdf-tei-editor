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
 * @import { Diagnostic } from '@codemirror/lint'
 * @import { EditorState } from '@codemirror/state'
 * @import { EditorView, ViewUpdate } from '@codemirror/view'
 */

import { closeLintPanel, forEachDiagnostic, setDiagnostics, setDiagnosticsEffect } from '@codemirror/lint';

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
 * A linter configured with `autoPanel: true` opens the lint panel on any
 * non-empty diagnostic set; unless `options.openPanel` is true, a panel that
 * was closed before the dispatch is closed again afterwards.
 * @param {EditorView} view
 * @param {string} source
 * @param {Diagnostic[]} own
 * @param {{openPanel?: boolean}} [options]
 */
export function applyMergedDiagnostics(view, source, own, options = {}) {
  const panelWasOpen = view.dom.querySelector('.cm-panel-lint') !== null;
  view.dispatch(setDiagnostics(view.state, mergeDiagnostics(view.state, source, own)));
  if (!panelWasOpen && !options.openPanel) closeLintPanel(view);
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
