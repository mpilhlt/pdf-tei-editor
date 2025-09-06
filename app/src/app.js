/**
 * PDF-TEI-Editor
 * 
 * A viewer/editor web app to compare the PDF source and automated TEI extraction/annotation
 * 
 * @author Christian Boulanger (@cboulanger), Max Planck Institute for Legal History and Legal Theory
 * @license CC0 1.0 Universal
 */

// Check for Safari and block it temporarily
if (navigator.userAgent.includes('Safari') && !navigator.userAgent.includes('Chrome')) {
  alert('Safari is currently not supported due to compatibility issues. Please use Chrome, Firefox, or Edge.');
  throw new Error('Safari browser not supported');
}

import ep from './endpoints.js'
import PluginManager from './modules/plugin-manager.js'
import StateManager from './modules/state-manager.js'
import Application from './modules/application.js'

// Import plugins and plugin APIs from plugins.js  
import plugins from './plugins.js'
import { logLevel, client, logger, config, dialog, AuthenticationPlugin } from './plugins.js'

// Import initial application state and its type definition
/** @import { ApplicationState } from './state.js' */
import initialState from './state.js'

//
// Application bootstrapping
//

// Create mutable copy of initial state
/** @type {ApplicationState} */
let state = { ...initialState }

// Create plugin manager and state manager singletons
const pluginManager = new PluginManager();
const stateManager = new StateManager();

// Create application instance
const app = new Application(pluginManager, stateManager)

// Export app early so it's available for dynamic imports during plugin installation
export { app }

// Register plugins
app.registerPlugins(plugins)

// Create authentication API export after plugin registration
export const authentication = AuthenticationPlugin.getInstance()

// Set log level after registration
await pluginManager.invoke(ep.log.setLogLevel, {level: logLevel.DEBUG})

// Compose initial application state from various sources
let serverState = await client.state()
let sessionState = stateManager.getStateFromSessionStorage();
if (sessionState) {
  logger.info("Loaded state from sessionStorage")
} else {
  logger.info("Loading initial state from server")
  sessionState = serverState
}

// special case where server state overrides saved state on reload
// this is a workaround to be fixed
sessionState.webdavEnabled = serverState.webdavEnabled

// Apply session state to current state 
Object.assign(state, sessionState)

// URL hash params override properties 
const allowSetFromUrl = (await config.get("state.allowSetFromUrl") || [])
const urlHashState = {}
const urlParams = new URLSearchParams(window.location.hash.slice(1));
for (const [key, value] of urlParams.entries()) {
  if (allowSetFromUrl.includes(key)) {
    urlHashState[key] = value
  }
}

if (Object.keys(urlHashState).length > 0) {
  logger.info("Setting state properties from URL hash: " + Object.keys(urlHashState).join(", "))
  Object.assign(state, urlHashState)
}

// Initialize application with final composed state
const persistedStateVars = (await config.get("state.persistedVars") || [])
app.initializeState(state, {
  persistedStateVars,
  enableStatePreservation: true
})

// Configure state manager
stateManager.preserveState(true, [...persistedStateVars, 'sessionId'])

// Install plugins with the final composed state
await app.installPlugins(state)

// Now notify plugins with the final initial state
await app.updateState(state, {})  

// invoke the "start" endpoint
await app.start()

//
// Legacy compatibility functions for old plugin system
//

/**
 * Legacy updateState function for backward compatibility with old plugins
 * @param {ApplicationState} currentState - The current state
 * @param {Partial<ApplicationState>} changes - Changes to apply
 * @returns {Promise<ApplicationState>} New state after changes applied
 * @deprecated Use app.updateState() instead
 */
async function updateState(currentState, changes = {}) {
  return await app.updateState(currentState, changes);
}

/**
 * Legacy hasStateChanged function for backward compatibility with old plugins
 * @param {ApplicationState} state - The current state
 * @param {...string} propertyNames - Property names to check for changes
 * @returns {boolean} True if any of the specified properties changed
 * @deprecated Use stateManager.hasStateChanged() instead
 */
function hasStateChanged(state, ...propertyNames) {
  return stateManager.hasStateChanged(state, ...propertyNames);
}

//
// Exports
// 

// application APIs and data
export {
  ep as endpoints, 
  pluginManager, 
  stateManager, 
  updateState, // Legacy compatibility
  hasStateChanged // Legacy compatibility
}

// Re-export all plugin APIs and plugins from plugins.js
export * from './plugins.js'
