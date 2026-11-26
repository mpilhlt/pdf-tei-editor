#!/usr/bin/env node

/**
 * Tests for finding a document by any of its PDFs and the PDF a version is attached to (#944).
 *
 * @testCovers app/src/modules/file-data-utils.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createIdLookupIndex,
  documentHasPdf,
  findFileBySourceId,
  getPdfOfArtifact
} from '../../../app/src/modules/file-data-utils.js';

/** @param {string} id */
const pdf = id => ({ id, filename: `${id}.pdf`, file_type: 'pdf', label: id, file_size: 1, created_at: '', updated_at: '', created_by: null });

// document doc1: canonical PDF p2 (made from p1 by text recognition), versions attached to either
const fileData = /** @type {any[]} */ ([
  {
    doc_id: 'doc1',
    collections: ['c1'],
    doc_metadata: {},
    source: pdf('p2'),
    pdfs: [pdf('p1'), pdf('p2')],
    artifacts: [
      { id: 'gold', pdf_id: 'p2', is_gold_standard: true },
      { id: 'v1', pdf_id: 'p1', is_gold_standard: false },
      { id: 'v2', is_gold_standard: false }
    ]
  },
  { doc_id: 'doc2', collections: [], doc_metadata: {}, source: pdf('q1'), artifacts: [] }
]);

describe('PDFs of a document', () => {
  it('finds a document by any of its PDFs', () => {
    assert.strictEqual(findFileBySourceId(fileData, 'p1')?.doc_id, 'doc1');
    assert.strictEqual(findFileBySourceId(fileData, 'p2')?.doc_id, 'doc1');
    assert.strictEqual(findFileBySourceId(fileData, 'q1')?.doc_id, 'doc2');
    assert.strictEqual(findFileBySourceId(fileData, 'nope'), null);
  });

  it('tells whether a PDF belongs to a document', () => {
    assert.strictEqual(documentHasPdf(fileData[0], 'p1'), true);
    assert.strictEqual(documentHasPdf(fileData[0], 'q1'), false);
    assert.strictEqual(documentHasPdf(fileData[1], 'q1'), true);
    assert.strictEqual(documentHasPdf(fileData[0], null), false);
  });

  it('returns the PDF a version is attached to', () => {
    assert.strictEqual(getPdfOfArtifact(fileData, 'v1'), 'p1');
    assert.strictEqual(getPdfOfArtifact(fileData, 'gold'), 'p2');
    assert.strictEqual(getPdfOfArtifact(fileData, 'v2'), null);
    assert.strictEqual(getPdfOfArtifact(fileData, 'nope'), null);
  });

  it('indexes all PDFs of a document', () => {
    const index = createIdLookupIndex(fileData);
    assert.strictEqual(index.get('p1')?.file.doc_id, 'doc1');
    assert.strictEqual(index.get('p1')?.type, 'source');
    assert.strictEqual(index.get('p2')?.item.id, 'p2');
  });
});
