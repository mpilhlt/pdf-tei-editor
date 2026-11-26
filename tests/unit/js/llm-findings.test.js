/**
 * Unit tests for the llm-findings module.
 *
 * @testCovers app/src/modules/llm-findings.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { locateFinding, buildModifiedText, findingsToDiagnostics, FindingsCache, FindingsDisplay, CACHE_VERSION } from '../../../app/src/modules/llm-findings.js';

/**
 * In-memory stand-in for SessionStorage, sharing its contexts through the given map.
 * @param {Map<string, Record<string, any>>} store
 */
function fakeStorage(store) {
  return {
    getValue: (contextId, key, defaultValue) => store.get(contextId)?.[key] ?? defaultValue,
    setState: (contextId, updates) => { store.set(contextId, { ...store.get(contextId), ...updates }); },
    clearState: (contextId) => { store.delete(contextId); },
  };
}

/**
 * Build a FindingsDisplay with fakes for the editor and lint-utils.
 * @param {{docText?: string, store?: Map<string, any>, replacesDiagnostics?: () => boolean, docId?: string|null}} opts
 */
function build(opts = {}) {
  const env = { docText: opts.docText ?? '', docId: opts.docId ?? null };
  const lintCalls = [], dismissListeners = [], updateListeners = [], handlers = {}, proposed = [];
  const store = opts.store ?? new Map();
  const display = new FindingsDisplay({
    source: 'test-source',
    getXmleditor: () => ({
      getView: () => ({ state: { doc: { toString: () => env.docText } } }),
      addUpdateListener: fn => { updateListeners.push(fn); },
      on: (event, fn) => { handlers[event] = fn; },
    }),
    getLintUtils: () => ({
      replacesDiagnostics: opts.replacesDiagnostics ?? (() => false),
      applyMergedDiagnostics: (view, source, own, options) => lintCalls.push({ source, own, options }),
      addDismissListener: fn => { dismissListeners.push(fn); },
    }),
    sessionStorage: fakeStorage(store),
    proposeFix: (finding, from, to) => proposed.push([finding.id, from, to]),
    getDocId: () => env.docId,
  });
  return { display, env, lintCalls, dismissListeners, updateListeners, handlers, proposed, store };
}

describe('locateFinding', () => {
  const finding = { id: 0, old: '<b>x</b>', new: '<i>x</i>', rationale: 'r' };

  it('returns the range of the single occurrence', () => {
    assert.deepStrictEqual(locateFinding(finding, 'aa<b>x</b>bb'), { from: 2, to: 10 });
  });

  it('returns null when old is absent', () => {
    assert.strictEqual(locateFinding(finding, 'nothing here'), null);
  });

  it('returns null when old occurs more than once', () => {
    assert.strictEqual(locateFinding(finding, '<b>x</b><b>x</b>'), null);
  });
});

describe('buildModifiedText', () => {
  const finding = { id: 0, old: 'BAD', new: 'GOOD', rationale: 'r' };

  it('replaces exactly the given range with the new text', () => {
    assert.strictEqual(buildModifiedText('a BAD b', 2, 5, finding), 'a GOOD b');
  });

  it('returns null when the text at the range no longer equals old', () => {
    assert.strictEqual(buildModifiedText('a XYZ b', 2, 5, finding), null);
  });
});

describe('findingsToDiagnostics', () => {
  it('builds one info diagnostic per locatable finding, with a Propose fix action', () => {
    const findings = [
      { id: 0, old: 'AAA', new: 'a', rationale: 'first' },
      { id: 1, old: 'MISSING', new: 'm', rationale: 'dropped' },
    ];
    const proposed = [];
    const result = findingsToDiagnostics(findings, 'x AAA y', (finding, from, to) => proposed.push([finding.id, from, to]));
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].severity, 'info');
    assert.strictEqual(result[0].message, 'first');
    assert.deepStrictEqual([result[0].from, result[0].to], [2, 5]);
    assert.strictEqual(result[0].actions[0].name, 'Propose fix');
    result[0].actions[0].apply({}, 2, 5);
    assert.deepStrictEqual(proposed, [[0, 2, 5]]);
  });

  it('carries the new text as the replacement applied by the diagnostics drawer', () => {
    const [d] = findingsToDiagnostics([{ id: 0, old: 'AAA', new: 'a', rationale: 'r' }], 'x AAA y', () => {});
    assert.strictEqual(d.replacement, 'a');
  });
});

describe('FindingsCache', () => {
  const findings = [{ id: 0, old: 'AAA', new: 'a', rationale: 'r' }];

  it('stores findings per document and removes the entry when there are none', () => {
    const store = new Map();
    const cache = new FindingsCache(fakeStorage(store));
    cache.save('doc1', findings);
    assert.deepStrictEqual(cache.load('doc1'), findings);
    assert.deepStrictEqual(cache.load('doc2'), []);
    cache.save('doc1', []);
    assert.strictEqual(store.has('doc1'), false);
  });

  it('ignores entries of another format version', () => {
    const store = new Map([['doc1', { review: { version: CACHE_VERSION + 1, findings } }]]);
    assert.deepStrictEqual(new FindingsCache(fakeStorage(store)).load('doc1'), []);
  });
});

describe('FindingsDisplay', () => {
  const finding = { id: 0, old: 'AAA', new: 'a', rationale: 'why' };
  const findings = [
    { id: 0, old: 'AAA', new: 'a', rationale: 'kept' },
    { id: 1, old: 'BBB', new: 'b', rationale: 'edited away' },
  ];

  it('show merges diagnostics under its source and opens the drawer', () => {
    const { display, lintCalls } = build({ docText: 'x AAA y' });
    display.show([finding]);
    assert.strictEqual(lintCalls[0].source, 'test-source');
    assert.deepStrictEqual(lintCalls[0].options, { openPanel: true });
    assert.deepStrictEqual(lintCalls[0].own.map(d => d.message), ['why']);
    assert.deepStrictEqual(display.findings, [finding]);
  });

  it('diagnostic actions call the supplied proposeFix', () => {
    const { display, lintCalls, proposed } = build({ docText: 'x AAA y' });
    display.show([finding]);
    lintCalls[0].own[0].actions[0].apply({}, 2, 5);
    assert.deepStrictEqual(proposed, [[0, 2, 5]]);
  });

  it('clear merges an empty own list, and does nothing without findings', () => {
    const { display, lintCalls } = build({ docText: 'x AAA y' });
    display.clear();
    assert.strictEqual(lintCalls.length, 0);
    display.show([finding]);
    display.clear();
    assert.deepStrictEqual(lintCalls.at(-1).own, []);
  });

  it('re-merges without opening the drawer when another source replaced the diagnostics', async () => {
    const { display, lintCalls, updateListeners } = build({ docText: 'x AAA y', replacesDiagnostics: () => true });
    display.attach();
    display.show([finding]);
    updateListeners[0]({ transactions: [] });
    await new Promise(r => setTimeout(r, 5));
    assert.strictEqual(lintCalls.length, 2);
    assert.deepStrictEqual(lintCalls[1].options, { openPanel: false });
  });

  it('does not re-merge while it is itself applying diagnostics', async () => {
    const { display, lintCalls, updateListeners } = build({ docText: 'x AAA y', replacesDiagnostics: () => true });
    display.attach();
    display._rendering = true;
    display._findings = [finding];
    updateListeners[0]({ transactions: [] });
    await new Promise(r => setTimeout(r, 5));
    assert.strictEqual(lintCalls.length, 0);
  });

  it('prunes a finding after the debounce when an edit removes its text', async () => {
    const { display, env, lintCalls, updateListeners } = build({ docText: 'x AAA BBB y' });
    display._pruneDelayMs = 5;
    display.attach();
    display.show(findings);
    env.docText = 'x AAA CCC y';
    updateListeners[0]({ docChanged: true, transactions: [] });
    assert.strictEqual(display.findings.length, 2);
    await new Promise(r => setTimeout(r, 30));
    assert.deepStrictEqual(display.findings.map(f => f.id), [0]);
    assert.deepStrictEqual(lintCalls.at(-1).own.map(d => d.message), ['kept']);
    assert.deepStrictEqual(lintCalls.at(-1).options, { openPanel: false });
  });

  it('restore drops cached findings that no longer occur exactly once', () => {
    const store = new Map();
    const before = build({ docText: 'x AAA BBB y', store });
    before.display.restore('doc1');
    before.display.show(findings);

    const after = build({ docText: 'x AAA CCC y', store });
    after.display.restore('doc1');
    assert.deepStrictEqual(after.display.findings.map(f => f.id), [0]);
    assert.deepStrictEqual(after.lintCalls.at(-1).own.map(d => d.message), ['kept']);
    assert.deepStrictEqual(after.lintCalls.at(-1).options, { openPanel: true });
  });

  it('restore waits for the editor content and is retried by editorAfterLoad', () => {
    const store = new Map([['doc1', { review: { version: CACHE_VERSION, findings: [finding] } }]]);
    const { display, env, handlers, lintCalls } = build({ docText: '', store, docId: 'doc1' });
    display.attach();
    display.restore('doc1');
    assert.strictEqual(lintCalls.length, 0);
    env.docText = 'x AAA y';
    handlers.editorAfterLoad();
    assert.deepStrictEqual(display.findings.map(f => f.id), [0]);
  });

  it('findings dismissed in the drawer are forgotten and removed from the cache', () => {
    const { display, dismissListeners, store } = build({ docText: 'x AAA BBB y' });
    display.attach();
    display.restore('doc1');
    display.show(findings);
    dismissListeners[0]([
      { from: 6, to: 9, severity: 'info', message: 'edited away', source: 'test-source' },
      { from: 2, to: 5, severity: 'error', message: 'kept' }, // foreign source: ignored
    ]);
    assert.deepStrictEqual(display.findings.map(f => f.id), [0]);
    assert.deepStrictEqual(store.get('doc1').review.findings.map(f => f.id), [0]);
  });

  it('switchDocument clears the editor but keeps the cache of the previous document', () => {
    const { display, lintCalls, store } = build({ docText: 'x AAA BBB y' });
    display.restore('doc1');
    display.show(findings);
    display.switchDocument('doc2');
    assert.deepStrictEqual(display.findings, []);
    assert.deepStrictEqual(lintCalls.at(-1).own, []);
    assert.deepStrictEqual(store.get('doc1').review.findings.map(f => f.id), [0, 1]);
  });
});
