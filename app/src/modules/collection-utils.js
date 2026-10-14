/**
 * Collection utility functions for ownership and access control.
 * @import { UserData } from '../plugins/authentication.js'
 * @import { ProjectInfo } from '../state.js'
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

/**
 * Returns the projects that are not archived.
 * @param {ProjectInfo[]} projects - All projects
 * @returns {ProjectInfo[]}
 */
export function getActiveProjects(projects) {
  return (projects || []).filter(p => !p.archived)
}

/**
 * Returns the IDs of collections that belong only to archived projects.
 *
 * A collection that is also part of a non-archived project is not included,
 * and collections that belong to no project are never considered archived.
 * @param {ProjectInfo[]} projects - All projects
 * @returns {Set<string>}
 */
export function getArchivedCollectionIds(projects) {
  const activeIds = new Set(getActiveProjects(projects).flatMap(p => p.collections || []))
  return new Set(
    (projects || [])
      .filter(p => p.archived)
      .flatMap(p => p.collections || [])
      .filter(colId => !activeIds.has(colId))
  )
}
