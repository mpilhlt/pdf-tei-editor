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

/** @import { ApplicationState } from './state.js' */

// plugin invocation endpoints
import ep from './endpoints.js'
export { ep as endpoints }

// plugins
import plugins, { services } from './plugins.js'
import { logLevel, client, config, AuthenticationPlugin, LoggerPlugin } from './plugins.js'
import initialState from './state.js'

// core application orchestration classes
import PluginManager from './modules/plugin-manager.js'
import StateManager from './modules/state-manager.js'
import Application from './modules/application.js'
import { createTestLogger } from '../../tests/e2e/helpers/test-logging.js'

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

// Create plugin API exports after plugin registration
export const authentication = AuthenticationPlugin.getInstance()
export const logger = LoggerPlugin.getInstance()

// Set log level after registration
logger.setLogLevel(logLevel.DEBUG)

// Compose initial application state from various sources
let serverState = await client.state()
let sessionState = stateManager.getStateFromSessionStorage();
if (sessionState) {
  logger.info("Loaded state from sessionStorage")
} else {
  logger.info("Loading initial state from server")
  sessionState = serverState
}

// server state overrides saved state on reload
sessionState.webdavEnabled = serverState.webdavEnabled
sessionState.hasInternet = serverState.hasInternet

// Apply session state to current state
Object.assign(state, sessionState)

// Create test logger based on configuration
const applicationMode = await config.get("application.mode")
export const testLog = createTestLogger(applicationMode)

// URL hash params override properties 
const allowSetFromUrl = (await config.get("state.allowSetFromUrl") || [])
const urlHashState = {}
const urlParams = new URLSearchParams(window.location.hash.slice(1));
for (const [key, value] of urlParams.entries()) {
  if (allowSetFromUrl.includes(key)) {
    // @ts-ignore
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
await app.updateState({})  

// invoke the "start" endpoint
await app.start()

// @test-start
// Expose necessary objects to global scope for E2E testing
if (applicationMode == 'testing' || applicationMode == 'development' ) {
  // @ts-ignore
  window.app = app;
  // @ts-ignore
  window.client = client;
  // @ts-ignore
  window.services = services;
  // @ts-ignore
  window.testLog = testLog;
}
// @test-end

//
// Legacy compatibility functions for old plugin system
//

/**
 * Legacy updateState function for backward compatibility with old plugins
 * Supports both old API: updateState(currentState, changes) and new API: updateState(changes)
 * @param {ApplicationState|Partial<ApplicationState>} currentStateOrChanges - The current state (old API) or changes (new API)
 * @param {Partial<ApplicationState>} [changes] - Changes to apply (old API only)
 * @returns {Promise<ApplicationState>} New state after changes applied
 * @deprecated Use app.updateState() instead
 */
export async function updateState(currentStateOrChanges, changes) {
  // New API: updateState(changes)
  if (changes === undefined) {
    return await app.updateState(currentStateOrChanges);
  }
  
  // Old API: updateState(currentState, changes) - ignore currentState, use changes only
  console.warn('updateState: Using deprecated 2-parameter API. The currentState parameter is ignored. Use updateState(changes) instead.');
  return await app.updateState(changes);
}

/**
 * Legacy hasStateChanged function for backward compatibility with old plugins
 * @param {ApplicationState} state - The current state
 * @param {...string} propertyNames - Property names to check for changes
 * @returns {boolean} True if any of the specified properties changed
 * @deprecated Use stateManager.hasStateChanged() instead
 */
export function hasStateChanged(state, ...propertyNames) {
  return stateManager.hasStateChanged(state, ...propertyNames);
}

export {
  /** @deprecated Don't use the pluginManager in plugins */
  pluginManager
}

// Re-export all plugin APIs and plugin objects from plugins.js for import by plugins
// TODO replace direct calls to a plugin's API with invoking endpoints
export * from './plugins.js'
