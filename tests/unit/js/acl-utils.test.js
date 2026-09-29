#!/usr/bin/env node

/**
 * @testCovers app/src/modules/acl-utils.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { userIsAnnotatorOnly } from '../../../app/src/modules/acl-utils.js';

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
