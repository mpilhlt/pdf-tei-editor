/**
 * @testCovers app/src/modules/sync-prompt.js
 * @testCovers app/src/modules/lint-utils.js
 * @import { Diagnostic } from '@codemirror/lint'
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { EditorState } from '@codemirror/state';
import { setDiagnostics } from '@codemirror/lint';
import { registerSyncSource, syncSourceNames, syncSourceOptions } from '../../../app/src/modules/lint-utils.js';
import { newEntries, pagesOf, promptText, syncEntries } from '../../../app/src/modules/sync-prompt.js';

const DOC = 'hello brave new world';

/** @param {(Diagnostic & {page?: number})[]} diagnostics */
function stateWith(diagnostics) {
  const base = EditorState.create({ doc: DOC });
  return base.update(setDiagnostics(base, diagnostics)).state;
}

const unregister = registerSyncSource('test-sync', { target: 'test training data' });
after(() => unregister());

describe('registerSyncSource', () => {
  it('registers and removes a source', () => {
    const remove = registerSyncSource('other', { target: 'x' });
    assert.deepStrictEqual(syncSourceOptions('other'), { target: 'x' });
    assert.ok(syncSourceNames().includes('other'));
    remove();
    assert.strictEqual(syncSourceOptions('other'), null);
    assert.strictEqual(syncSourceOptions(undefined), null);
  });
});

describe('syncEntries', () => {
  it('keeps errors and warnings of sync sources that name a page', () => {
    const state = stateWith([
      { from: 0, to: 5, severity: 'warning', message: 'a', source: 'test-sync', page: 2 },
      { from: 6, to: 11, severity: 'info', message: 'note', source: 'test-sync', page: 2 },
      { from: 6, to: 11, severity: 'error', message: 'no page', source: 'test-sync' },
      { from: 12, to: 15, severity: 'error', message: 'schema', source: 'validation', page: 1 }
    ]);
    const entries = syncEntries(state);
    assert.deepStrictEqual(entries.map(e => e.diagnostic.message), ['a']);
    assert.strictEqual(entries[0].target, 'test training data');
  });

  it('keys do not depend on the position', () => {
    const d = { from: 0, to: 5, severity: /** @type {const} */ ('warning'), message: 'a', source: 'test-sync', page: 0 };
    const [first] = syncEntries(stateWith([d]));
    const moved = EditorState.create({ doc: `x ${DOC}` });
    const [second] = syncEntries(moved.update(setDiagnostics(moved, [{ ...d, from: 2, to: 7 }])).state);
    assert.strictEqual(first.key, second.key);
    assert.deepStrictEqual(newEntries([second], new Set([first.key])), []);
  });
});

describe('pagesOf and promptText', () => {
  const entry = (page, target) => ({ diagnostic: { from: 0, to: 1, severity: 'warning', message: '', page }, key: String(page), target });

  it('sorts pages without duplicates', () => {
    assert.deepStrictEqual(pagesOf([entry(3, 't'), entry(1, 't'), entry(3, 't')]), [1, 3]);
  });

  it('names the text layer and the targets', () => {
    assert.match(promptText([entry(0, 'GROBID training data')]), /the PDF text layer and the GROBID training data need to be updated/);
    assert.match(promptText([entry(0, 'PDF text layer')]), /intentional, the PDF text layer needs to be updated/);
  });

  it('describes differences found when the document was loaded', () => {
    const text = promptText([entry(1, 'GROBID training data'), entry(4, 'GROBID training data'), entry(1, 'GROBID training data')], 'load');
    assert.match(text, /^The text of this document differs from the PDF in 3 places \(pages 2 and 5\)\./);
    assert.match(text, /intended, for example corrections that were not written into the PDF yet, the PDF text layer and the GROBID training data need to be updated/);
    assert.match(promptText([entry(0, 'PDF text layer')], 'load'), /in 1 place \(page 1\)\. .* the PDF text layer needs to be updated/);
  });
});
