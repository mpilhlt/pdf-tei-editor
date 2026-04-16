/**
 * Collection utility functions for ownership and access control.
 * @import { UserData } from '../plugins/authentication.js'
 */

import { userIsAdmin } from './acl-utils.js'

/**
 * @typedef {object} CollectionData
 * @property {string} id - Collection identifier
 * @property {string} name - Collection display name
 * @property {string} [description] - Collection description
 * @property {string|null} [owner] - Username of the collection owner, or null if unowned
 */

/**
 * Returns the owner username of a collection, or null if unowned.
 * @param {CollectionData} collection - Collection object
 * @returns {string|null}
 */
export function getCollectionOwner(collection) {
  return collection?.owner ?? null
}

/**
 * Checks if a user is the owner of a collection.
 * @param {UserData|null} user - User object
 * @param {CollectionData} collection - Collection object
 * @returns {boolean}
 */
export function isCollectionOwner(user, collection) {
  if (!user || !collection) return false
  const owner = getCollectionOwner(collection)
  return owner !== null && user.username === owner
}

/**
 * Checks if a user may delete a collection.
 *
 * Deletion is allowed for admins and the collection owner.
 * @param {UserData|null} user - User object
 * @param {CollectionData} collection - Collection object
 * @returns {boolean}
 */
export function canDeleteCollection(user, collection) {
  if (!user) return false
  return userIsAdmin(user) || isCollectionOwner(user, collection)
}
