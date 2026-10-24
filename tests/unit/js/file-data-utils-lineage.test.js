#!/usr/bin/env node

/**
 * @testCovers app/src/modules/file-data-utils.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { groupVersionsByLineage } from '../../../app/src/modules/file-data-utils.js';

/**
 * @param {string} id
 * @param {number} version
 * @param {string|null} parent_id
 * @param {boolean} [is_frozen]
 */
const v = (id, version, parent_id, is_frozen = false) => /** @type {any} */ ({ id, version, parent_id, is_frozen });

/** @param {ReturnType<typeof groupVersionsByLineage>} groups */
const ids = groups => groups.map(g => [g.leaves.map(a => a.id), g.ancestors.map(a => a.id)]);

describe('groupVersionsByLineage', () => {
  it('groups siblings with their ancestor chain, nearest ancestor first', () => {
    const versions = [v('v1', 1, 'gold', true), v('v2', 2, 'v1', true), v('v3', 3, 'v2'), v('v4', 4, 'v2'), v('v5', 5, 'v1')];
    assert.deepStrictEqual(ids(groupVersionsByLineage(versions)), [
      [['v3', 'v4'], ['v2', 'v1']],
      [['v5'], ['v1']]
    ]);
  });

  it('ends the chain at ancestors that are not listed, such as gold', () => {
    const versions = [v('v1', 1, 'gold'), v('v2', 2, 'gold')];
    assert.deepStrictEqual(ids(groupVersionsByLineage(versions)), [[['v1', 'v2'], []]]);
  });

  it('puts versions without a known parent into one group', () => {
    const versions = [v('a', 1, null), v('b', 2, 'unknown')];
    assert.deepStrictEqual(ids(groupVersionsByLineage(versions)), [[['a', 'b'], []]]);
  });

  it('keeps frozen versions that are no ancestor of a listed leaf', () => {
    const versions = [v('v1', 1, null, true), v('v2', 2, null)];
    assert.deepStrictEqual(ids(groupVersionsByLineage(versions)), [[['v2'], []], [[], ['v1']]]);
  });

  it('stops on a parent cycle', () => {
    const versions = [v('a', 1, 'b', true), v('b', 2, 'a', true), v('c', 3, 'a')];
    assert.deepStrictEqual(ids(groupVersionsByLineage(versions)), [[['c'], ['a', 'b']]]);
  });
});
