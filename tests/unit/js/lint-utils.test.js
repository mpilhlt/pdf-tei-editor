/**
 * @testCovers app/src/modules/lint-utils.js
 * @import { Diagnostic } from '@codemirror/lint'
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EditorState } from '@codemirror/state';
import { setDiagnostics } from '@codemirror/lint';
import {
  addDismissListener, applyMergedDiagnostics, clearDiagnosticsOnChange, collectDiagnostics, diagnosticKey, dismissDiagnostics, fixChanges,
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

  it('does not dispatch a merge that leaves the diagnostics unchanged', () => {
    const view = fakeView(stateWith([validation]));
    const own = [{ from: 6, to: 11, severity: 'info', message: 'm', actions: [{ name: 'Propose fix', apply() {} }] }];
    applyMergedDiagnostics(/** @type {any} */ (view), 's', own);
    applyMergedDiagnostics(/** @type {any} */ (view), 's', own.map(d => ({ ...d, actions: [{ name: 'Propose fix', apply() {} }] })));
    applyMergedDiagnostics(/** @type {any} */ (view), 'other', []);
    assert.strictEqual(view.dispatched.length, 1);
    // a changed fix or action list is dispatched
    applyMergedDiagnostics(/** @type {any} */ (view), 's', own.map(d => ({ ...d, replacement: 'x' })));
    applyMergedDiagnostics(/** @type {any} */ (view), 's', own.map(d => ({ ...d, replacement: 'x', actions: [] })));
    assert.strictEqual(view.dispatched.length, 3);
  });

  it('ends the re-merging of two sources that re-merge after every replacement (#647)', () => {
    const view = fakeView(stateWith([validation]));
    const own = { a: [{ from: 6, to: 11, severity: 'info', message: 'a' }], b: [] };
    // each replacement makes the other source re-merge: a, b, a, b, ...
    for (let i = 0; i < 10; i++) {
      const source = i % 2 ? 'b' : 'a';
      applyMergedDiagnostics(/** @type {any} */ (view), source, own[source]);
    }
    assert.strictEqual(view.dispatched.length, 1);
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

describe('clearDiagnosticsOnChange', () => {
  const brave = { from: 6, to: 11, severity: 'info', message: 'brave', source: 'annotation-review' };
  const world = { from: 16, to: 21, severity: 'warning', message: 'world' };

  /** @param {Diagnostic[]} diagnostics */
  function editorWith(diagnostics) {
    const base = EditorState.create({ doc: DOC, extensions: [clearDiagnosticsOnChange()] });
    return base.update(setDiagnostics(base, diagnostics)).state;
  }

  it('removes the diagnostics touched by a change in the same transaction and maps the others', () => {
    const tr = editorWith([validation, brave, world]).update({ changes: { from: 7, to: 9, insert: 'XYZ' } });
    assert.strictEqual(replacesDiagnostics({ transactions: [tr] }), true);
    const kept = collectDiagnostics(tr.state);
    assert.deepStrictEqual(kept.map(d => [d.message, d.from, d.to]), [['schema error', 0, 5], ['world', 17, 22]]);
    assert.strictEqual(tr.state.doc.sliceString(kept[1].from, kept[1].to), 'world');
  });

  it('keeps the fields of the remaining diagnostics', () => {
    const action = { name: 'x', apply() {} };
    const tr = editorWith([validation, { ...world, source: 's', actions: [action] }]).update({ changes: { from: 1, insert: 'h' } });
    const [d] = collectDiagnostics(tr.state);
    assert.strictEqual(d.source, 's');
    assert.strictEqual(d.actions[0].name, 'x');
  });

  it('removes all diagnostics when the whole document is replaced', () => {
    const state = editorWith([validation, brave, world]);
    const tr = state.update({ changes: { from: 0, to: state.doc.length, insert: 'new document' } });
    assert.deepStrictEqual(collectDiagnostics(tr.state), []);
  });

  it('leaves a change that touches no diagnostic alone', () => {
    const tr = editorWith([brave]).update({ changes: { from: DOC.length, insert: '!' } });
    assert.strictEqual(replacesDiagnostics({ transactions: [tr] }), false);
    assert.deepStrictEqual(collectDiagnostics(tr.state).map(d => d.message), ['brave']);
  });

  it('leaves a transaction alone that sets the diagnostics itself', () => {
    const state = editorWith([brave]);
    const tr = state.update({ changes: { from: 7, insert: 'x' }, ...setDiagnostics(state, [{ ...brave, from: 6, to: 12 }]) });
    assert.deepStrictEqual(collectDiagnostics(tr.state).map(d => [d.message, d.from, d.to]), [['brave', 6, 12]]);
  });
});
