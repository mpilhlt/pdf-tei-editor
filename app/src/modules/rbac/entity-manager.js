/**
 * Entity Manager for RBAC Entities
 *
 * Provides generic CRUD operations for all RBAC entity types.
 * Handles API communication and state management.
 */

/**
 * @import { EntitySchema } from './entity-schemas.js'
 */

import { getEntitySchema, validateEntity } from './entity-schemas.js'

/**
 * Entity manager class for handling CRUD operations
 */
export class EntityManager {
  /**
   * @param {string} entityType - Entity type (user, group, role, collection)
   * @param {Function} apiClient - API client function (e.g., client.callApi)
   */
  constructor(entityType, apiClient) {
    this.entityType = entityType
    this.apiClient = apiClient
    this.schema = getEntitySchema(entityType)

    if (!this.schema) {
      throw new Error(`Unknown entity type: ${entityType}`)
    }

    // Cache for entity data
    /** @type {Record<string, any>[]} */
    this.entities = []
  }

  /**
   * Get the API endpoint base for this entity type
   * @returns {string}
   */
  getEndpointBase() {
    // Map entity types to API endpoints
    const endpoints = {
      user: '/users',
      group: '/groups',
      role: '/roles',
      collection: '/collections'
    }
    return endpoints[this.entityType] || `/${this.entityType}s`
  }

  /**
   * Load all entities from server
   * @returns {Promise<Record<string, any>[]>}
   */
  async loadAll() {
    try {
      const endpoint = this.getEndpointBase()
      const response = await this.apiClient(endpoint, 'GET')

      // Response structure might vary by entity type
      // Collections API returns {collections: [...]}
      // Need to handle both array and object responses
      if (Array.isArray(response)) {
        this.entities = response
      } else if (response[this.entityType + 's']) {
        this.entities = response[this.entityType + 's']
      } else {
        // Fallback for unknown response structure
        this.entities = []
      }

      return this.entities
    } catch (error) {
      console.error(`Failed to load ${this.entityType}s:`, error)
      throw error
    }
  }

  /**
   * Get a single entity by ID
   * @param {string} id - Entity ID
   * @returns {Promise<Record<string, any> | null>}
   */
  async getById(id) {
    try {
      const endpoint = `${this.getEndpointBase()}/${encodeURIComponent(id)}`
      const response = await this.apiClient(endpoint, 'GET')
      return response
    } catch (error) {
      console.error(`Failed to get ${this.entityType} ${id}:`, error)
      return null
    }
  }

  /**
   * Create a new entity
   * @param {Record<string, any>} data - Entity data
   * @returns {Promise<Record<string, any>>}
   */
  async create(data) {
    // Validate data
    const validation = validateEntity(this.entityType, data, true)
    if (!validation.valid) {
      throw new Error(`Validation failed: ${validation.errors.join(', ')}`)
    }

    try {
      const endpoint = this.getEndpointBase()
      const response = await this.apiClient(endpoint, 'POST', data)

      // Add to local cache
      this.entities.push(response)

      return response
    } catch (error) {
      console.error(`Failed to create ${this.entityType}:`, error)
      throw error
    }
  }

  /**
   * Update an existing entity
   * @param {string} id - Entity ID
   * @param {Record<string, any>} data - Updated entity data
   * @returns {Promise<Record<string, any>>}
   */
  async update(id, data) {
    // Validate data (not new, so immutable fields allowed)
    const validation = validateEntity(this.entityType, data, false)
    if (!validation.valid) {
      throw new Error(`Validation failed: ${validation.errors.join(', ')}`)
    }

    try {
      const endpoint = `${this.getEndpointBase()}/${encodeURIComponent(id)}`
      const response = await this.apiClient(endpoint, 'PUT', data)

      // Update local cache
      const index = this.entities.findIndex(e => e[this.schema.idField] === id)
      if (index !== -1) {
        this.entities[index] = response
      }

      return response
    } catch (error) {
      console.error(`Failed to update ${this.entityType} ${id}:`, error)
      throw error
    }
  }

  /**
   * Delete an entity
   * @param {string} id - Entity ID
   * @returns {Promise<void>}
   */
  async delete(id) {
    try {
      const endpoint = `${this.getEndpointBase()}/${encodeURIComponent(id)}`
      await this.apiClient(endpoint, 'DELETE')

      // Remove from local cache
      this.entities = this.entities.filter(e => e[this.schema.idField] !== id)
    } catch (error) {
      console.error(`Failed to delete ${this.entityType} ${id}:`, error)
      throw error
    }
  }

  /**
   * Get all cached entities
   * @returns {Record<string, any>[]}
   */
  getAll() {
    return [...this.entities]
  }

  /**
   * Find entity by ID in cache
   * @param {string} id - Entity ID
   * @returns {Record<string, any> | undefined}
   */
  findById(id) {
    return this.entities.find(e => e[this.schema.idField] === id)
  }

  /**
   * Search entities by field value
   * @param {string} field - Field name to search
   * @param {any} value - Value to search for
   * @returns {Record<string, any>[]}
   */
  search(field, value) {
    return this.entities.filter(e => {
      const fieldValue = e[field]
      if (typeof fieldValue === 'string') {
        return fieldValue.toLowerCase().includes(value.toLowerCase())
      }
      return fieldValue === value
    })
  }

  /**
   * Refresh cache from server
   * @returns {Promise<Record<string, any>[]>}
   */
  async refresh() {
    return this.loadAll()
  }
}

/**
 * Create entity managers for all RBAC entity types
 * @param {Function} apiClient - API client function
 * @returns {Record<string, EntityManager>}
 */
export function createEntityManagers(apiClient) {
  return {
    user: new EntityManager('user', apiClient),
    group: new EntityManager('group', apiClient),
    role: new EntityManager('role', apiClient),
    collection: new EntityManager('collection', apiClient)
  }
}
