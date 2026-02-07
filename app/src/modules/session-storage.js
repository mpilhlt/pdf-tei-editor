/**
 * Session Storage Helper Module
 *
 * Provides a class for plugins to store/retrieve state in sessionStorage
 * using a structured key hierarchy.
 */

/**
 * Session storage helper for plugin state persistence.
 * Stores all values under a single namespaced key with support for
 * both context-specific state (e.g., per-document) and global settings.
 */
export class SessionStorage {
  /**
   * @param {string} namespace - The storage namespace (e.g., 'pdfviewer', 'xmleditor')
   */
  constructor(namespace) {
    this._storageKey = `plugin.${namespace}.state`
  }

  /**
   * Gets all stored state from session storage
   * @returns {Record<string, any>}
   * @private
   */
  _getAllState() {
    try {
      return JSON.parse(sessionStorage.getItem(this._storageKey) || '{}')
    } catch {
      return {}
    }
  }

  /**
   * Saves all state to session storage
   * @param {Record<string, any>} state
   * @private
   */
  _saveAllState(state) {
    try {
      sessionStorage.setItem(this._storageKey, JSON.stringify(state))
    } catch (error) {
      console.warn(`Failed to save session state for ${this._storageKey}:`, error)
    }
  }

  /**
   * Gets the stored state for a specific context (e.g., document ID)
   * @param {string} contextId - The context identifier
   * @returns {Record<string, any>} The stored state or empty object
   */
  getState(contextId) {
    const allState = this._getAllState()
    return allState[contextId] || {}
  }

  /**
   * Gets a single value from context-specific state
   * @param {string} contextId - The context identifier
   * @param {string} key - The state key
   * @param {*} [defaultValue] - Default value if not set
   * @returns {*} The stored value or default
   */
  getValue(contextId, key, defaultValue) {
    const state = this.getState(contextId)
    return state[key] ?? defaultValue
  }

  /**
   * Updates the stored state for a specific context
   * @param {string} contextId - The context identifier
   * @param {Record<string, any>} updates - State properties to update
   */
  setState(contextId, updates) {
    const allState = this._getAllState()
    allState[contextId] = { ...allState[contextId], ...updates }
    this._saveAllState(allState)
  }

  /**
   * Sets a single value in context-specific state
   * @param {string} contextId - The context identifier
   * @param {string} key - The state key
   * @param {*} value - The value to store
   */
  setValue(contextId, key, value) {
    this.setState(contextId, { [key]: value })
  }

  /**
   * Clears the stored state for a specific context
   * @param {string} contextId - The context identifier
   */
  clearState(contextId) {
    const allState = this._getAllState()
    delete allState[contextId]
    this._saveAllState(allState)
  }

  /**
   * Gets a global setting (not context-specific)
   * @param {string} key - The setting key
   * @param {*} [defaultValue] - Default value if not set
   * @returns {*} The stored value or default
   */
  getGlobal(key, defaultValue) {
    const allState = this._getAllState()
    return allState._global?.[key] ?? defaultValue
  }

  /**
   * Sets a global setting (not context-specific)
   * @param {string} key - The setting key
   * @param {*} value - The value to store
   */
  setGlobal(key, value) {
    const allState = this._getAllState()
    if (!allState._global) allState._global = {}
    allState._global[key] = value
    this._saveAllState(allState)
  }

  /**
   * Clears all stored state for this namespace
   */
  clearAll() {
    sessionStorage.removeItem(this._storageKey)
  }
}
