/**
 * State management utilities for immutable state updates with history tracking
 * @import { ApplicationState } from '../app.js'
 */

import ep from '../endpoints.js'
import { invoke } from './plugin-utils.js'

// Maximum number of states to keep in history
const MAX_STATE_HISTORY = 10;

// Array to track state history for garbage collection
let stateHistory = [];

/**
 * Internal function to create a new state object with changes applied
 * 
 * @param {ApplicationState} currentState - The current application state  
 * @param {Partial<ApplicationState>} changes - Key-value pairs of state changes to apply
 * @returns {{newState: ApplicationState, changedKeys: string[]}} New state and changed keys
 */
function createStateWithChanges(currentState, changes = {}) {
  // Create new state object with all current properties
  const newState = { ...currentState };
  
  // Ensure ext object is properly copied (shallow copy for extensions)
  if (currentState.ext) {
    newState.ext = { ...currentState.ext };
  }
  
  // Apply changes to new state
  const changedKeys = [];
  Object.entries(changes).forEach(([key, value]) => {
    if (currentState[key] !== value) {
      newState[key] = value;
      changedKeys.push(key);
    }
  });
  
  // Add reference to previous state for immediate comparison
  newState.previousState = currentState;
  
  // Add new state to history array
  stateHistory.push(newState);
  
  // Manage history size and garbage collection
  if (stateHistory.length > MAX_STATE_HISTORY) {
    // Get the state that will be removed from history
    const oldestState = stateHistory.shift();
    
    // Find the state that points to the oldest state and break the chain
    const secondOldest = stateHistory[0];
    if (secondOldest && secondOldest.previousState === oldestState) {
      secondOldest.previousState = null;
    }
    
    // Clear the oldest state's previousState reference for GC
    if (oldestState && oldestState.previousState) {
      oldestState.previousState = null;
    }
  }
  
  return { newState, changedKeys };
}

/**
 * Creates a new state object with changes applied (for initialization, does not notify plugins)
 * 
 * @param {ApplicationState} currentState - The current application state
 * @param {Partial<ApplicationState>} changes - Key-value pairs of state changes to apply
 * @returns {ApplicationState} New state object with changes applied
 */
export function createNewState(currentState, changes = {}) {
  const { newState } = createStateWithChanges(currentState, changes);
  return newState;
}

/**
 * Updates the application state immutably with proper history management
 * 
 * @param {ApplicationState} currentState - The current application state
 * @param {Partial<ApplicationState>} changes - Key-value pairs of state changes to apply
 * @returns {Promise<Array>} Returns array of results from plugin state.update endpoints
 */
export async function updateState(currentState, changes = {}) {
  const { newState, changedKeys } = createStateWithChanges(currentState, changes);
  
  // If no changes, return early
  if (changedKeys.length === 0) {
    return await invoke(ep.state.update, currentState);
  }
  
  // Notify all plugins of state update
  return await invoke(ep.state.update, newState);
}

/**
 * Utility function to check if specific keys have changed between current and previous state
 * 
 * @param {ApplicationState} state - Current state object
 * @param {...keyof ApplicationState} keys - State keys to check for changes
 * @returns {boolean} True if any of the specified keys have changed
 */
export function hasStateChanged(state, ...keys) {
  if (!state.previousState) return true; // First state, consider all keys changed
  
  return keys.some(key => state[key] !== state.previousState?.[key]);
}

/**
 * Gets all keys that have changed between current and previous state
 * 
 * @param {ApplicationState} state - Current state object
 * @returns {Array<keyof ApplicationState>} Array of keys that have changed
 */
export function getChangedStateKeys(state) {
  let result; 
  if (!state.previousState) {
    result = Object.keys(state).filter(key => key !== 'previousState');
  } else {
    result = Object.keys(state).filter(key => 
      key !== 'previousState' && state[key] !== state.previousState?.[key]
    );
  }
  return /** @type {Array<keyof ApplicationState>} */ (result) 
}

/**
 * Gets the previous value of a specific state key
 * 
 * @param {ApplicationState} state - Current state object
 * @param {keyof ApplicationState} key - State key to get previous value for
 * @returns {any} Previous value or undefined if no previous state
 */
export function getPreviousStateValue(state, key) {
  return state.previousState?.[key];
}

/**
 * Clears the state history array (useful for testing or memory cleanup)
 */
export function clearStateHistory() {
  // Break all previousState chains
  stateHistory.forEach(state => {
    if (state.previousState) {
      state.previousState = null;
    }
  });
  
  stateHistory = [];
}

/**
 * Gets the current size of the state history
 * 
 * @returns {number} Number of states currently in history
 */
export function getStateHistorySize() {
  return stateHistory.length;
}

// State preservation variables
const SESSION_STORAGE_ID = 'pdf-tei-editor.state';
let beforeUnloadHandler = null;

/**
 * Gets saved state from sessionStorage
 * 
 * @returns {Object|null} Saved state object or null if none found/invalid
 */
export function getStateFromSessionStorage() {
  try {
    const stateInSessionStorage = sessionStorage.getItem(SESSION_STORAGE_ID);
    return stateInSessionStorage ? JSON.parse(stateInSessionStorage) : null;
  } catch (error) {
    console.warn("Failed to load state from sessionStorage:", error);
    return null;
  }
}

/**
 * Enables or disables automatic state preservation in sessionStorage on page unload
 * 
 * @param {boolean} doPreserve - Whether to preserve state (true) or stop preserving (false)
 */
export function preserveState(doPreserve = true) {
  if (doPreserve && !beforeUnloadHandler) {
    // Create and register the beforeunload handler
    beforeUnloadHandler = () => {
      // Save the newest state from history (last entry)
      const newestState = stateHistory[stateHistory.length - 1];
      if (newestState) {
        console.log("DEBUG Saving state in sessionStorage");
        sessionStorage.setItem(SESSION_STORAGE_ID, JSON.stringify(newestState));
      }
    };
    window.addEventListener('beforeunload', beforeUnloadHandler);
  } else if (!doPreserve && beforeUnloadHandler) {
    // Remove the handler
    window.removeEventListener('beforeunload', beforeUnloadHandler);
    beforeUnloadHandler = null;
  }
}

/**
 * Updates extension properties in state.ext immutably
 * 
 * @param {ApplicationState} state - Current state object
 * @param {Record<string, any>} extChanges - Extension properties to update
 * @returns {Promise<Array>} Returns array of results from plugin state.update endpoints
 */
export async function updateStateExt(state, extChanges) {
  const newExt = { ...state.ext, ...extChanges };
  return await updateState(state, { ext: newExt });
}