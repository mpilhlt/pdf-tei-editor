#!/usr/bin/env node

/**
 * @testCovers app/src/modules/acl-utils.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { userIsAnnotatorOnly, isFrozenFile, canEditFile } from '../../../app/src/modules/acl-utils.js';
import { createIdLookupIndex } from '../../../app/src/modules/file-data-utils.js';

describe('userIsAnnotatorOnly', () => {
  it('returns true for a user with only the annotator role', () => {
    assert.strictEqual(userIsAnnotatorOnly({ username: 'a', roles: ['annotator'] }), true);
  });

  it('returns false for a user with annotator and reviewer roles', () => {
    assert.strictEqual(userIsAnnotatorOnly({ username: 'a', roles: ['annotator', 'reviewer'] }), false);
  });

  it('returns false for a user with annotator and admin roles', () => {
    assert.strictEqual(userIsAnnotatorOnly({ username: 'a', roles: ['annotator', 'admin'] }), false);
  });

  it('returns false for a user without the annotator role', () => {
    assert.strictEqual(userIsAnnotatorOnly({ username: 'a', roles: ['reviewer'] }), false);
  });

  it('returns false for a user with the "*" wildcard role', () => {
    assert.strictEqual(userIsAnnotatorOnly({ username: 'a', roles: ['*'] }), false);
  });

  it('returns false for a null user', () => {
    assert.strictEqual(userIsAnnotatorOnly(null), false);
  });
});

describe('frozen versions', () => {
  const fileData = [{
    doc_id: 'doc',
    collections: ['c'],
    doc_metadata: {},
    source: { id: 'pdf1', filename: 'a.pdf', file_type: 'pdf', label: 'A', file_size: 1, created_at: '', updated_at: '', created_by: null },
    artifacts: [
      { id: 'gold1', filename: 'g', file_type: 'tei', label: 'Gold', file_size: 1, created_at: '', updated_at: '', created_by: null, variant: null, version: null, is_gold_standard: true, is_locked: false, is_frozen: true },
      { id: 'ver1', filename: 'v', file_type: 'tei', label: 'v1', file_size: 1, created_at: '', updated_at: '', created_by: 'annotator', variant: null, version: 1, is_gold_standard: false, is_locked: false, parent_id: 'gold1', is_frozen: false }
    ]
  }];

  it('isFrozenFile reads the flag from the file data', () => {
    createIdLookupIndex(fileData);
    assert.strictEqual(isFrozenFile('gold1'), true);
    assert.strictEqual(isFrozenFile('ver1'), false);
    assert.strictEqual(isFrozenFile('unknown'), false);
  });

  it('canEditFile denies frozen files even to admins', () => {
    createIdLookupIndex(fileData);
    const admin = { username: 'admin', roles: ['admin'] };
    assert.strictEqual(canEditFile(admin, 'gold1'), false);
    assert.strictEqual(canEditFile(admin, 'ver1'), true);
  });
});
