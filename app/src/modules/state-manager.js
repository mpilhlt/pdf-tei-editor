/**
 * Pure state management class for immutable state updates with history tracking
 * @import { ApplicationState } from '../state.js'
 */

// WeakMap to store state history without creating memory leaks
const stateHistory = new WeakMap();

/**
 * StateManager class handles pure state operations without plugin dependencies
 */
export class StateManager {
  constructor() {
    this.preserveStateEnabled = false;
    this.persistedStateVars = [];
  }

  /**
   * Internal function to create a new state object with changes applied
   * 
   * @param {ApplicationState} currentState - The current application state  
   * @param {Partial<ApplicationState>} changes - Key-value pairs of state changes to apply
   * @returns {{newState: ApplicationState, changedKeys: string[]}} New state and changed keys
   */
  createStateWithChanges(currentState, changes = {}) {
    // Create new state object with all current properties
    const newState = { ...currentState };
    
    // Track which keys actually changed
    const changedKeys = [];
    
    // Apply changes and track modifications
    for (const [key, value] of Object.entries(changes)) {
      if (currentState[key] !== value) {
        changedKeys.push(key);
        newState[key] = value;
        
        // Special handling for ext object - ensure proper shallow copy
        if (key === 'ext' && value && typeof value === 'object') {
          newState.ext = { ...value };
        }
      }
    }
    
    // Link to previous state using WeakMap (no memory leak issues)
    if (currentState) {
      stateHistory.set(newState, currentState);
    }
    
    return { newState, changedKeys };
  }

  /**
   * Create new state with changes applied (pure function)
   * 
   * @param {ApplicationState} currentState - The current application state
   * @param {Partial<ApplicationState>} changes - Key-value pairs of state changes to apply
   * @returns {{newState: ApplicationState, changedKeys: string[]}} The new state and list of changed keys
   */
  applyStateChanges(currentState, changes = {}) {
    const { newState, changedKeys } = this.createStateWithChanges(currentState, changes);
    
    // Preserve state if enabled
    if (this.preserveStateEnabled && changedKeys.length > 0) {
      this.saveStateToSessionStorage(newState);
    }
    
    return { newState, changedKeys };
  }

  /**
   * Apply extension properties changes to state (pure function)
   * 
   * @param {ApplicationState} currentState - The current application state
   * @param {Object} extChanges - Extension properties to update
   * @returns {{newState: ApplicationState, changedKeys: string[]}} The new state with updated extensions
   */
  applyExtensionChanges(currentState, extChanges = {}) {
    const newExt = { ...(currentState.ext || {}), ...extChanges };
    return this.applyStateChanges(currentState, { ext: newExt });
  }

  /**
   * Get the previous state for a given state
   * 
   * @param {ApplicationState} state - Current state
   * @returns {ApplicationState|undefined} Previous state or undefined if none
   */
  getPreviousState(state) {
    return stateHistory.get(state);
  }

  /**
   * Check if specific state properties have changed from the previous state
   * 
   * @param {ApplicationState} state - Current state to check
   * @param {...string} propertyNames - Names of properties to check for changes
   * @returns {boolean} True if any of the specified properties have changed
   */
  hasStateChanged(state, ...propertyNames) {
    const previousState = this.getPreviousState(state);
    if (!previousState) {
      return true; // First state, everything is "changed"
    }
    
    return propertyNames.some(prop => {
      const currentValue = prop.includes('.') ? this.getNestedProperty(state, prop) : state[prop];
      const previousValue = prop.includes('.') ? this.getNestedProperty(previousState, prop) : previousState[prop];
      return currentValue !== previousValue;
    });
  }

  /**
   * Get all property names that have changed from the previous state
   * 
   * @param {ApplicationState} state - Current state to analyze
   * @returns {Array<keyof ApplicationState>} Array of property names that have changed
   */
  getChangedStateKeys(state) {
    const previousState = this.getPreviousState(state);
    if (!previousState) {
      const keys = /** @type {Array<keyof ApplicationState>} */  (Object.keys(state))
      return keys;
    }
    
    const changedKeys = /** @type {Array<keyof ApplicationState>} */ ([]);
    for (const key in state) {
      if (state[key] !== previousState[key]) {
        // @ts-ignore
        changedKeys.push(key);
      }
    }
    return changedKeys;
  }

  /**
   * Get the previous value of a state property
   * 
   * @param {ApplicationState} state - Current state
   * @param {string} propertyName - Name of the property to get previous value for
   * @returns {*} Previous value of the property, or undefined if no previous state
   */
  getPreviousStateValue(state, propertyName) {
    const previousState = this.getPreviousState(state);
    if (!previousState) {
      return undefined;
    }
    
    if (propertyName.includes('.')) {
      return this.getNestedProperty(previousState, propertyName);
    }
    
    return previousState[propertyName];
  }

  /**
   * Get nested property value using dot notation
   * 
   * @param {Object} obj - Object to traverse
   * @param {string} path - Dot-separated path to property
   * @returns {*} Value at the path, or undefined if not found
   * @private
   */
  getNestedProperty(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  /**
   * Enable automatic state preservation in sessionStorage
   * 
   * @param {boolean} enabled - Whether to enable preservation
   * @param {string[]} [persistedVars] - Specific state variables to persist
   */
  preserveState(enabled = true, persistedVars = []) {
    this.preserveStateEnabled = enabled;
    this.persistedStateVars = persistedVars;
  }

  /**
   * Save specific state variables to sessionStorage
   * 
   * @param {ApplicationState} state - State to save
   * @private
   */
  saveStateToSessionStorage(state) {
    if (!this.preserveStateEnabled) return;
    
    const stateToSave = {};
    
    // Save only specified variables, or all if "*"
    const varsToSave = this.persistedStateVars.includes("*") ?
     Object.keys(state) : this.persistedStateVars;
    
    for (const key of varsToSave) {
      if (state[key] !== undefined && state[key] !== null) {
        stateToSave[key] = state[key];
      }
    }
    
    try {
      sessionStorage.setItem('pdf-tei-editor.state', JSON.stringify(stateToSave));
    } catch (error) {
      console.warn('Failed to save state to sessionStorage:', error);
    }
  }

  /**
   * Load state from sessionStorage
   * 
   * @returns {ApplicationState|null} Saved state or null if none found
   */
  getStateFromSessionStorage() {
    try {
      const saved = sessionStorage.getItem('pdf-tei-editor.state');
      return saved ? JSON.parse(saved) : null;
    } catch (error) {
      console.warn('Failed to load state from sessionStorage:', error);
      return null;
    }
  }
}

export default StateManager;