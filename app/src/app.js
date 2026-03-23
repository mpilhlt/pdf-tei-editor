/**
 * PDF-TEI-Editor
 * 
 * A viewer/editor web app to compare the PDF source and automated TEI extraction/annotation
 * 
 * @author Christian Boulanger (@cboulanger), Max Planck Institute for Legal History and Legal Theory
 * @license CC0 1.0 Universal
 */

/** @import { ApplicationState } from './state.js' */

// plugins
import plugins from './plugins.js'
import { logLevel } from './plugins/logger.js'
import { LoggerPlugin } from './plugin-registry.js'
import initialState from './state.js'

// core application orchestration classes
import PluginManager from './modules/plugin-manager.js'
import StateManager from './modules/state-manager.js'
import Application from './modules/application.js'
import { configureTestLog, testLog } from './modules/test-log.js'

// frontend extension system
import { loadExtensionsFromServer } from './modules/frontend-extension-registry.js'
import { initializeSandbox } from './modules/frontend-extension-sandbox.js'

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

// Register plugins
app.registerPlugins(plugins)

// Resolve plugin singletons after registration
const client = pluginManager.getDependency('client')
const config = pluginManager.getDependency('config')
const services = pluginManager.getDependency('services')

// Initialize frontend extension sandbox with state getter, invoke function, updateState, and plugin getter
// TODO: the sandbox system needs to be refactored
initializeSandbox(
  () => app.getCurrentState(),
  (endpoint, args, options) => pluginManager.invoke(endpoint, args, options),
  (changes) => app.updateState(changes),
  (pluginName) => pluginManager.getDependency(pluginName)
)

// Load and register frontend extensions from backend plugins
await loadExtensionsFromServer(pluginManager)

// Create logger and set log level
const logger = LoggerPlugin.getInstance()
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
sessionState.hasInternet = serverState.hasInternet

// Apply session state to current state
Object.assign(state, sessionState)

// Configure test logger based on application mode
const applicationMode = await config.get("application.mode")
configureTestLog(applicationMode)

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

// @test-start
// Expose necessary objects to global scope for E2E testing
// TODO expose all plugins as global objects
if (applicationMode == 'testing' || applicationMode == 'development' ) {
  // @ts-ignore
  window.app = app;
  // @ts-ignore
  window.client = client;
  // @ts-ignore
  window.services = services;
  // @ts-ignore
  window.testLog = testLog;
  // @ts-ignore
  window.sse = pluginManager.getDependency('sse');
    // @ts-ignore
  window.progress = pluginManager.getDependency('progress');
}
// @test-end

// Now notify plugins with the final initial state
await app.updateState({})  

// invoke the "start" endpoint
await app.start()

