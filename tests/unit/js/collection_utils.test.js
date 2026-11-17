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
  canDeleteCollection,
  getActiveProjects,
  getArchivedCollectionIds,
  compareCollectionNames,
  sortCollections,
  sortProjectCollections
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

/** @param {string} id @param {string[]} collections @param {boolean} [archived] */
const proj = (id, collections, archived = false) => ({ id, name: id, description: '', members: [], collections, archived })

describe('getActiveProjects', () => {
  it('excludes archived projects', () => {
    const projects = [proj('a', ['c1']), proj('b', ['c2'], true), { ...proj('c', []), archived: undefined }]
    assert.deepStrictEqual(getActiveProjects(projects).map(p => p.id), ['a', 'c'])
  })
})

describe('getArchivedCollectionIds', () => {
  it('returns collections that belong only to archived projects', () => {
    const projects = [proj('a', ['c1', 'shared']), proj('b', ['c2', 'shared'], true)]
    assert.deepStrictEqual([...getArchivedCollectionIds(projects)], ['c2'])
  })

  it('returns an empty set when no project is archived', () => {
    assert.strictEqual(getArchivedCollectionIds([proj('a', ['c1'])]).size, 0)
  })
})

describe('sortCollections', () => {
  it('sorts by name with numbers compared by value, ignoring the id order', () => {
    const collections = [
      { id: 'fossil-01', name: 'Fossil Batch 01' },
      { id: 'fossil-10', name: 'Fossil Batch 10' },
      { id: 'fossil-02', name: 'Fossil Batch 02' },
      { id: 'b', name: 'batch 9' },
    ]
    assert.deepStrictEqual(sortCollections(collections).map(c => c.id), ['b', 'fossil-01', 'fossil-02', 'fossil-10'])
  })

  it('compares names case-insensitively and numerically', () => {
    assert.ok(compareCollectionNames('Batch 2', 'batch 10') < 0)
    assert.strictEqual(compareCollectionNames('Inbox', 'inbox'), 0)
  })
})

describe('sortProjectCollections', () => {
  it('orders the collection ids of each project by collection name and keeps unknown ids last', () => {
    const collections = [
      { id: 'fossil-1', name: 'Fossil Batch 01' },
      { id: 'fossil-10', name: 'Fossil Batch 10' },
      { id: 'fossil-2', name: 'Fossil Batch 02' },
    ]
    const projects = [proj('p', ['fossil-1', 'unknown', 'fossil-10', 'fossil-2'])]
    const sorted = sortProjectCollections(projects, collections)
    assert.deepStrictEqual(sorted[0].collections, ['fossil-1', 'fossil-2', 'fossil-10', 'unknown'])
    assert.deepStrictEqual(projects[0].collections, ['fossil-1', 'unknown', 'fossil-10', 'fossil-2'])
  })
})
