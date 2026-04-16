/**
 * Unit tests for collection-utils.js
 *
 * @testCovers app/src/modules/collection-utils.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  getCollectionOwner,
  isCollectionOwner,
  canDeleteCollection
} from '../../../app/src/modules/collection-utils.js'

/** @param {string} username @param {string[]} [roles] @returns {import('../../../app/src/plugins/authentication.js').UserData} */
const user = (username, roles = ['user']) => ({ username, fullname: username, roles })

/** @param {string|null} [owner] @returns {import('../../../app/src/modules/collection-utils.js').CollectionData} */
const col = (owner = undefined) => ({ id: 'test', name: 'Test', owner: owner ?? undefined })

describe('getCollectionOwner', () => {
  it('returns owner string when present', () => {
    assert.strictEqual(getCollectionOwner({ id: 'c', name: 'C', owner: 'alice' }), 'alice')
  })

  it('returns null when owner is absent', () => {
    assert.strictEqual(getCollectionOwner({ id: 'c', name: 'C' }), null)
  })

  it('returns null when owner is undefined', () => {
    assert.strictEqual(getCollectionOwner({ id: 'c', name: 'C', owner: undefined }), null)
  })

  it('returns null for null collection', () => {
    assert.strictEqual(getCollectionOwner(/** @type {any} */ (null)), null)
  })
})

describe('isCollectionOwner', () => {
  it('returns true when username matches owner', () => {
    assert.ok(isCollectionOwner(user('alice'), col('alice')))
  })

  it('returns false when username does not match owner', () => {
    assert.ok(!isCollectionOwner(user('bob'), col('alice')))
  })

  it('returns false when collection has no owner', () => {
    assert.ok(!isCollectionOwner(user('alice'), col()))
  })

  it('returns false for null user', () => {
    assert.ok(!isCollectionOwner(null, col('alice')))
  })

  it('returns false for null collection', () => {
    assert.ok(!isCollectionOwner(user('alice'), /** @type {any} */ (null)))
  })
})

describe('canDeleteCollection', () => {
  it('returns true for admin role', () => {
    assert.ok(canDeleteCollection(user('admin_user', ['admin']), col()))
  })

  it('returns true for wildcard role', () => {
    assert.ok(canDeleteCollection(user('super', ['*']), col()))
  })

  it('returns true for reviewer who owns the collection', () => {
    assert.ok(canDeleteCollection(user('rev', ['reviewer']), col('rev')))
  })

  it('returns false for reviewer who does not own the collection', () => {
    assert.ok(!canDeleteCollection(user('rev', ['reviewer']), col('someone_else')))
  })

  it('returns true for collection owner (plain user)', () => {
    assert.ok(canDeleteCollection(user('alice', ['user']), col('alice')))
  })

  it('returns false for plain user who is not owner', () => {
    assert.ok(!canDeleteCollection(user('bob', ['user']), col('alice')))
  })

  it('returns false for plain user on unowned collection', () => {
    assert.ok(!canDeleteCollection(user('bob', ['user']), col()))
  })

  it('returns false for null user', () => {
    assert.ok(!canDeleteCollection(null, col('alice')))
  })
})
