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

const user = (username, roles = ['user']) => ({ username, roles })
const col = (owner = undefined) => ({ id: 'test', name: 'Test', owner })

describe('getCollectionOwner', () => {
  it('returns owner string when present', () => {
    assert.strictEqual(getCollectionOwner(col('alice')), 'alice')
  })

  it('returns null when owner is null', () => {
    assert.strictEqual(getCollectionOwner(col(null)), null)
  })

  it('returns null when owner field is absent', () => {
    assert.strictEqual(getCollectionOwner({ id: 'c', name: 'C' }), null)
  })

  it('returns null for null collection', () => {
    assert.strictEqual(getCollectionOwner(null), null)
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
    assert.ok(!isCollectionOwner(user('alice'), col(null)))
  })

  it('returns false for null user', () => {
    assert.ok(!isCollectionOwner(null, col('alice')))
  })

  it('returns false for null collection', () => {
    assert.ok(!isCollectionOwner(user('alice'), null))
  })
})

describe('canDeleteCollection', () => {
  it('returns true for admin role', () => {
    assert.ok(canDeleteCollection(user('admin_user', ['admin']), col()))
  })

  it('returns true for wildcard role', () => {
    assert.ok(canDeleteCollection(user('super', ['*']), col()))
  })

  it('returns true for reviewer role', () => {
    assert.ok(canDeleteCollection(user('rev', ['reviewer']), col('someone_else')))
  })

  it('returns true for collection owner (plain user)', () => {
    assert.ok(canDeleteCollection(user('alice', ['user']), col('alice')))
  })

  it('returns false for plain user who is not owner', () => {
    assert.ok(!canDeleteCollection(user('bob', ['user']), col('alice')))
  })

  it('returns false for plain user on unowned collection', () => {
    assert.ok(!canDeleteCollection(user('bob', ['user']), col(null)))
  })

  it('returns false for null user', () => {
    assert.ok(!canDeleteCollection(null, col('alice')))
  })
})
