/**
 * Access Control List utility functions for role-based permissions
 * @import { UserData } from '../plugins/authentication.js'
 */

import { logger } from '../app.js'
import { getFileDataByHash } from './file-data-utils.js'

/**
 * Checks if user has one or more specific roles
 * @param {UserData|null} user - User object
 * @param {string|string[]} role - Role name or array of role names
 * @returns {boolean}
 * @note If user has "*" in their roles array, they match any role check
 */
export function userHasRole(user, role) {
  if (!user || !user.roles) {
    return false
  }

  // Wildcard "*" in user's roles grants access to any role check
  if (user.roles.includes('*')) {
    return true
  }

  if (Array.isArray(role)) {
    return role.some(r => user.roles.includes(r))
  }

  return user.roles.includes(role)
}

/**
 * Checks if user has all specified roles
 * @param {UserData|null} user - User object
 * @param {string[]} roles - Array of role names
 * @returns {boolean}
 * @note If user has "*" in their roles array, they match any role check
 */
export function userHasAllRoles(user, roles) {
  if (!user || !user.roles || !Array.isArray(roles)) {
    return false
  }

  // Wildcard "*" in user's roles grants access to any role check
  if (user.roles.includes('*')) {
    return true
  }

  return roles.every(role => user.roles.includes(role))
}

/**
 * Checks if user is an admin
 * @param {UserData|null} user - User object
 * @returns {boolean}
 */
export function userIsAdmin(user) {
  return userHasRole(user, 'admin')
}

/**
 * Checks if user owns a resource
 * @param {UserData|null} user - User object
 * @param {string|null} owner - Owner username
 * @returns {boolean}
 */
export function userOwnsResource(user, owner) {
  if (!user || !owner) {
    return false
  }

  return user.username === owner
}

/**
 * Checks if user can access a resource based on ownership or admin privileges
 * @param {UserData|null} user - User object
 * @param {string|null} owner - Resource owner username
 * @returns {boolean}
 */
export function userCanAccessOwnedResource(user, owner) {
  return userIsAdmin(user) || userOwnsResource(user, owner)
}

/**
 * Gets all roles for a user as an array
 * @param {UserData|null} user - User object
 * @returns {string[]}
 */
export function getUserRoles(user) {
  return user?.roles || []
}

/**
 * Checks if user has any roles at all
 * @param {UserData|null} user - User object
 * @returns {boolean}
 */
export function userHasAnyRole(user) {
  // @ts-ignore
  return user?.roles?.length > 0
}

/**
 * Filters an array of roles to only include those the user has
 * @param {UserData|null} user - User object
 * @param {string[]} roles - Array of role names to filter
 * @returns {string[]}
 */
export function filterUserRoles(user, roles) {
  if (!user || !user.roles || !Array.isArray(roles)) {
    return []
  }

  return roles.filter(role => user.roles.includes(role))
}

/**
 * Creates a permission checker function for a specific role
 * @param {string} role - Role name
 * @returns {function(UserData|null): boolean}
 */
export function createRoleChecker(role) {
  return (user) => userHasRole(user, role)
}

/**
 * Creates a permission checker function for multiple roles (OR logic)
 * @param {string[]} roles - Array of role names
 * @returns {function(UserData|null): boolean}
 */
export function createAnyRoleChecker(roles) {
  return (user) => userHasRole(user, roles)
}

/**
 * Creates a permission checker function for multiple roles (AND logic)
 * @param {string[]} roles - Array of role names
 * @returns {function(UserData|null): boolean}
 */
export function createAllRolesChecker(roles) {
  return (user) => userHasAllRoles(user, roles)
}

/**
 * Checks if user has reviewer role
 * @param {UserData|null} user - User object
 * @returns {boolean}
 */
export function userHasReviewerRole(user) {
  if (!user) return false
  return userHasRole(user, 'reviewer')
}

/**
 * Checks if user has annotator role
 * @param {UserData|null} user - User object
 * @returns {boolean}
 */
export function userHasAnnotatorRole(user) {
  if (!user) return false
  return userHasRole(user, 'annotator')
}

/**
 * Checks if a file hash represents a gold file
 * @param {string} hash - The file hash identifier
 * @returns {boolean}
 */
export function isGoldFile(hash) {
  if (!hash) return false
  try {
    const fileData = getFileDataByHash(hash)
    return fileData?.type === 'gold'
  } catch (error) {
    logger.warn(`Error checking if file is gold: ${String(error)}`)
    return false
  }
}

/**
 * Checks if a file hash represents a version file
 * @param {string} hash - The file hash identifier
 * @returns {boolean}
 */
export function isVersionFile(hash) {
  if (!hash) return false
  try {
    const fileData = getFileDataByHash(hash)
    return fileData?.type === 'version'
  } catch (error) {
    logger.warn(`Error checking if file is version: ${String(error)}`)
    return false
  }
}

/**
 * Checks if user can edit a document based on permissions and file type
 * @param {UserData|null} user - Current user object
 * @param {{visibility: string, editability: string, owner: string|null}} permissions - Document permissions
 * @param {string} [fileId] - Optional file ID to check file type restrictions
 * @returns {boolean}
 */
export function canEditDocumentWithPermissions(user, permissions, fileId) {
  if (!user) {
    return false
  }

  // Admin users can edit everything
  if (userIsAdmin(user)) {
    return true
  }

  // Check role-based file type restrictions
  if (fileId) {
    if (isGoldFile(fileId) && !userHasReviewerRole(user)) {
      return false
    }

    if (isVersionFile(fileId) && !userHasAnnotatorRole(user) && !userHasReviewerRole(user)) {
      return false
    }
  }

  // Check visibility permissions
  if (permissions.visibility === 'private' && permissions.owner !== user.username) {
    return false
  }

  // Check editability permissions
  if (permissions.editability === 'protected' && permissions.owner !== user.username) {
    return false
  }

  return true
}

/**
 * Checks if user can view a document based on permissions
 * @param {UserData|null} user - Current user object
 * @param {{visibility: string, owner: string|null}} permissions - Document permissions
 * @returns {boolean}
 */
export function canViewDocumentWithPermissions(user, permissions) {
  // Admin users can view everything
  if (user && userIsAdmin(user)) {
    return true
  }

  // Public documents can be viewed by anyone
  if (permissions.visibility === 'public') {
    return true
  }

  // Private documents only viewable by owner
  if (permissions.visibility === 'private') {
    if (!user) return false
    return permissions.owner === user.username
  }

  return false
}

/**
 * Checks if user can edit a file based on access control metadata
 * @param {UserData|null} user - Current user object
 * @param {string} fileId - The file identifier (hash)
 * @returns {boolean}
 */
export function canEditFile(user, fileId) {
  try {
    if (!user) {
      return false
    }

    // Admin users can edit everything
    if (userIsAdmin(user)) {
      return true
    }

    // Check role-based file type restrictions
    if (isGoldFile(fileId) && !userHasReviewerRole(user)) {
      return false
    }

    if (isVersionFile(fileId) && !userHasAnnotatorRole(user) && !userHasReviewerRole(user)) {
      return false
    }

    // Get file metadata for additional access control checks
    const fileData = getFileDataByHash(fileId)
    if (!fileData || fileData.type === 'pdf' || !('metadata' in fileData.item) || !fileData.item.metadata?.access_control) {
      // No metadata found or no access control info - role-based restrictions already checked above
      logger.debug('No access control metadata found for file')
      return true
    }

    const { visibility, editability, owner } = fileData.item.metadata.access_control

    // Check visibility permissions
    if (visibility === 'private' && owner !== user.username) {
      return false
    }

    // Check editability permissions
    if (editability === 'protected' && owner !== user.username) {
      return false
    }

    return true
  } catch (error) {
    logger.warn(`Error checking file access permissions: ${String(error)}`)
    // Default to allowing edit on error to avoid breaking functionality
    return true
  }
}