#!/usr/bin/env node

/**
 * @testCovers app/src/modules/file-data-utils.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { pickDocumentCollection } from '../../../app/src/modules/file-data-utils.js';

describe('pickDocumentCollection', () => {
  it('keeps the current collection if the document belongs to it', () => {
    assert.strictEqual(pickDocumentCollection(['a', 'b'], 'b', 'a'), 'b');
  });

  it('falls through to the next preferred collection that contains the document', () => {
    assert.strictEqual(pickDocumentCollection(['a', 'b'], 'c', 'b'), 'b');
    assert.strictEqual(pickDocumentCollection(['a', 'b'], null, 'b'), 'b');
  });

  it('falls back to the first collection of the document', () => {
    assert.strictEqual(pickDocumentCollection(['a', 'b'], 'c', ''), 'a');
    assert.strictEqual(pickDocumentCollection(['a', 'b']), 'a');
  });

  it('returns null for a document without collections', () => {
    assert.strictEqual(pickDocumentCollection([], 'a'), null);
  });
});
