/**
 * @testCovers app/src/modules/lint-utils.js
 * @import { Diagnostic } from '@codemirror/lint'
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EditorState } from '@codemirror/state';
import { setDiagnostics } from '@codemirror/lint';
import {
  addDismissListener, applyMergedDiagnostics, collectDiagnostics, diagnosticKey, dismissDiagnostics, fixChanges,
  mergeDiagnostics, replacesDiagnostics, revealsDiagnostics
} from '../../../app/src/modules/lint-utils.js';

const DOC = 'hello brave new world';

/** @param {Diagnostic[]} diagnostics */
function stateWith(diagnostics) {
  const base = EditorState.create({ doc: DOC });
  return base.update(setDiagnostics(base, diagnostics)).state;
}

const validation = { from: 0, to: 5, severity: 'error', message: 'schema error' };

describe('collectDiagnostics', () => {
  it('returns [] for a state without lint state', () => {
    assert.deepStrictEqual(collectDiagnostics(EditorState.create({ doc: DOC })), []);
  });

  it('returns stored diagnostics including their actions and source', () => {
    const action = { name: 'x', apply() {} };
    const state = stateWith([{ ...validation, source: 's', actions: [action] }]);
    const [d] = collectDiagnostics(state);
    assert.strictEqual(d.message, 'schema error');
    assert.strictEqual(d.source, 's');
    assert.strictEqual(d.actions[0].name, 'x');
  });
});

describe('mergeDiagnostics', () => {
  it('keeps foreign diagnostics and appends own ones tagged with the source', () => {
    const state = stateWith([validation]);
    const merged = mergeDiagnostics(state, 'annotation-review', [
      { from: 6, to: 11, severity: 'info', message: 'rationale' },
    ]);
    assert.strictEqual(merged.length, 2);
    assert.ok(merged.some(d => d.message === 'schema error'));
    assert.strictEqual(merged.find(d => d.message === 'rationale').source, 'annotation-review');
  });

  it('replaces earlier diagnostics of the same source instead of duplicating them', () => {
    const state = stateWith([
      validation,
      { from: 6, to: 11, severity: 'info', message: 'old rationale', source: 'annotation-review' },
    ]);
    const merged = mergeDiagnostics(state, 'annotation-review', [
      { from: 12, to: 15, severity: 'info', message: 'new rationale' },
    ]);
    assert.deepStrictEqual(merged.map(d => d.message).sort(), ['new rationale', 'schema error']);
  });

  it('removes all diagnostics of the source when given an empty list', () => {
    const state = stateWith([
      validation,
      { from: 6, to: 11, severity: 'info', message: 'r', source: 'annotation-review' },
    ]);
    assert.deepStrictEqual(mergeDiagnostics(state, 'annotation-review', []).map(d => d.message), ['schema error']);
  });
});

describe('replacesDiagnostics', () => {
  it('is true for an update whose transaction carries setDiagnosticsEffect', () => {
    const base = EditorState.create({ doc: DOC });
    const tr = base.update(setDiagnostics(base, [validation]));
    assert.strictEqual(replacesDiagnostics({ transactions: [tr] }), true);
  });

  it('is false for a plain document edit', () => {
    const base = EditorState.create({ doc: DOC });
    const tr = base.update({ changes: { from: 0, insert: 'x' } });
    assert.strictEqual(replacesDiagnostics({ transactions: [tr] }), false);
  });
});

describe('applyMergedDiagnostics with a real EditorView (jsdom)', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const w = dom.window;
  for (const k of ['window', 'document', 'Window', 'Document', 'ShadowRoot', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'Range', 'getSelection', 'requestAnimationFrame', 'cancelAnimationFrame', 'DOMRect', 'KeyboardEvent', 'MouseEvent', 'Event']) {
    if (!(k in globalThis) || k === 'navigator') Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  if (!('navigator' in globalThis)) Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
  const { EditorView } = await import('@codemirror/view');
  const { linter } = await import('@codemirror/lint');
  const { applyMergedDiagnostics } = await import('../../../app/src/modules/lint-utils.js');

  /** @returns {EditorView} */
  function makeView() {
    const parent = w.document.body.appendChild(w.document.createElement('div'));
    return new EditorView({ doc: DOC, parent, extensions: [linter(() => [])] });
  }
  const own = [{ from: 0, to: 5, severity: 'info', message: 'm' }];
  const panelOpen = (/** @type {EditorView} */ v) => v.dom.querySelector('.cm-panel-lint') !== null;

  it('stores the merged diagnostics without opening the lint panel, also with openPanel', () => {
    const view = makeView();
    applyMergedDiagnostics(view, 'ar', own);
    applyMergedDiagnostics(view, 'ar', own, { openPanel: true });
    assert.strictEqual(panelOpen(view), false);
    assert.strictEqual(collectDiagnostics(view.state).length, 1);
  });
});

describe('applyMergedDiagnostics', () => {
  /** @param {EditorState} state */
  function fakeView(state) {
    const view = { state, dispatched: [], dispatch(spec) { view.dispatched.push(spec); view.state = view.state.update(spec).state; } };
    return view;
  }

  it('adds the reveal effect only with openPanel', () => {
    const view = fakeView(EditorState.create({ doc: DOC }));
    applyMergedDiagnostics(/** @type {any} */ (view), 's', [validation]);
    applyMergedDiagnostics(/** @type {any} */ (view), 's', [validation], { openPanel: true });
    const updates = view.dispatched.map(spec => ({ transactions: [EditorState.create({ doc: DOC }).update(spec)] }));
    assert.deepStrictEqual(updates.map(u => revealsDiagnostics(u)), [false, true]);
    assert.strictEqual(collectDiagnostics(view.state).length, 1);
  });
});

describe('diagnosticKey', () => {
  it('is equal for re-created diagnostics covering the same text, and differs otherwise', () => {
    const state = EditorState.create({ doc: DOC });
    const a = diagnosticKey(state, { ...validation });
    assert.strictEqual(a, diagnosticKey(state, { ...validation }));
    assert.notStrictEqual(a, diagnosticKey(state, { ...validation, from: 6, to: 11 }));
    assert.notStrictEqual(a, diagnosticKey(state, { ...validation, source: 'x' }));
  });
});

describe('dismissDiagnostics', () => {
  it('removes the given diagnostics and notifies the dismiss listeners', () => {
    const other = { from: 6, to: 11, severity: 'info', message: 'r', source: 'annotation-review' };
    const view = { state: stateWith([validation, other]), dispatch(spec) { view.state = view.state.update(spec).state; } };
    const notified = [];
    const remove = addDismissListener(d => notified.push(d));
    try {
      dismissDiagnostics(/** @type {any} */ (view), [{ ...other }]);
    } finally {
      remove();
    }
    assert.deepStrictEqual(collectDiagnostics(view.state).map(d => d.message), ['schema error']);
    assert.strictEqual(notified.length, 1);
    assert.strictEqual(notified[0][0].message, 'r');
  });
});

describe('fixChanges', () => {
  it('returns sorted changes for diagnostics with a replacement, skipping others and overlaps', () => {
    const { changes, applied } = fixChanges([
      { from: 12, to: 15, severity: 'info', message: 'b', replacement: 'NEW' },
      { from: 0, to: 5, severity: 'error', message: 'no fix' },
      { from: 6, to: 11, severity: 'info', message: 'a', replacement: 'BRAVE' },
      { from: 8, to: 13, severity: 'info', message: 'overlaps a', replacement: 'x' },
    ]);
    assert.deepStrictEqual(changes, [{ from: 6, to: 11, insert: 'BRAVE' }, { from: 12, to: 15, insert: 'NEW' }]);
    assert.deepStrictEqual(applied.map(d => d.message), ['a', 'b']);
  });
});
