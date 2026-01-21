/**
 * @file Global TEI enhancement registration system.
 * Enhancements are loaded dynamically from the backend plugin system.
 */

/**
 * @import { ApplicationState } from '../state.js'
 */

/**
 * Enhancement execute function signature
 * @typedef {function(Document, ApplicationState, Map<string, any>): Document} EnhancementExecuteFunction
 */

/**
 * @typedef {Object} EnhancementDef
 * @property {string} name - The name of the enhancement
 * @property {string} description - A brief description
 * @property {string} [pluginId] - The backend plugin that provided this enhancement
 * @property {EnhancementExecuteFunction} execute - The function to execute
 */

/** @type {EnhancementDef[]} */
const registeredEnhancements = [];

/**
 * Register a TEI enhancement globally.
 * Called by dynamically loaded enhancement scripts from backend plugins.
 * @param {EnhancementDef} enhancement
 */
function registerTeiEnhancement(enhancement) {
  if (!enhancement.name || !enhancement.execute) {
    console.error('Invalid enhancement: missing name or execute function', enhancement);
    return;
  }

  // Prevent duplicate registration
  const existingIndex = registeredEnhancements.findIndex(e => e.name === enhancement.name);
  if (existingIndex >= 0) {
    console.warn(`Enhancement "${enhancement.name}" already registered, replacing`);
    registeredEnhancements[existingIndex] = enhancement;
    return;
  }

  registeredEnhancements.push(enhancement);
  console.log(`Registered TEI enhancement: ${enhancement.name} (from ${enhancement.pluginId || 'unknown'})`);
}

/**
 * Get all registered enhancements
 * @returns {EnhancementDef[]}
 */
function getEnhancements() {
  return [...registeredEnhancements];
}

/**
 * Clear all registered enhancements (useful for testing)
 */
function clearEnhancements() {
  registeredEnhancements.length = 0;
}

// Expose global registration function for dynamically loaded scripts
window.registerTeiEnhancement = registerTeiEnhancement;

export { registerTeiEnhancement, getEnhancements, clearEnhancements };
