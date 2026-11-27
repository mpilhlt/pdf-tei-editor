#!/usr/bin/env node

/**
 * @testCovers app/src/modules/text-corrections.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { summarizePreview } from '../../../app/src/modules/text-corrections.js';

const correction = { page: 0, line: 3, old: 'teh', new: 'the' };
const unwritable = { page: 1, line: 2, layer_text: 'a b', tei_text: 'a', reason: 'word count differs' };

describe('summarizePreview', () => {
  it('cannot apply when a reason is set, and still reports the unwritable changes', () => {
    const s = summarizePreview({ corrections: [], unwritable: [unwritable], affected_files: [], reason: 'The document has no text corrections to write.' });
    assert.strictEqual(s.canApply, false);
    assert.strictEqual(s.needsSkip, false);
    assert.match(s.text, /no text corrections/);
    assert.match(s.text, /1 change/);
  });

  it('needs skip when applicable with unwritable changes', () => {
    const s = summarizePreview({ corrections: [correction], unwritable: [unwritable], affected_files: [], reason: null });
    assert.strictEqual(s.canApply, true);
    assert.strictEqual(s.needsSkip, true);
  });

  it('plain preview mentions the number of corrections', () => {
    const s = summarizePreview({ corrections: [correction], unwritable: [], affected_files: [] });
    assert.strictEqual(s.canApply, true);
    assert.strictEqual(s.needsSkip, false);
    assert.match(s.text, /1 correction/);
  });

  it('pluralizes', () => {
    const s = summarizePreview({ corrections: [correction, correction], unwritable: [], affected_files: [] });
    assert.match(s.text, /2 corrections/);
  });

  it('can apply without corrections when the document must be updated for corrections written page by page', () => {
    const s = summarizePreview({ corrections: [], unwritable: [], reason: null, update_pending: true });
    assert.strictEqual(s.canApply, true);
    assert.match(s.text, /page by page/);
    assert.doesNotMatch(s.text, /0 corrections/);
  });

  it('mentions the update along with the corrections', () => {
    const s = summarizePreview({ corrections: [correction], unwritable: [], reason: null, update_pending: true });
    assert.match(s.text, /1 correction will be written/);
    assert.match(s.text, /page by page before/);
  });
});
