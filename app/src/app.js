/**
 * PDF-TEI-Editor
 * 
 * @author Christian Boulanger (@cboulanger), Max Planck Institute for Legal History and Legal Theory
 * @license 
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
import Plugin from './modules/plugin-base.js';

// ???
import { createHashLookupIndex } from './modules/file-data-utils.js'

// class-based plugins
import AuthenticationPlugin from './plugins/authentication-new.js'

// legacy plugins
import { plugin as loggerPlugin, api as logger, logLevel} from './plugins/logger.js'
import { plugin as configPlugin, api as config } from './plugins/config.js'
import { plugin as urlHashStatePlugin, api as urlHash } from './plugins/url-hash-state.js'
import { plugin as ssePlugin, api as sse} from './plugins/sse.js'
import { plugin as dialogPlugin, api as dialog } from './plugins/dialog.js'
import { plugin as pdfViewerPlugin, api as pdfViewer } from './plugins/pdfviewer.js'
import { plugin as xmlEditorPlugin, api as xmlEditor } from './plugins/xmleditor.js'
import { plugin as validationPlugin, api as validation } from './plugins/tei-validation.js'
import { plugin as clientPlugin, api as client } from './plugins/client.js'
import { plugin as fileselectionPlugin, api as fileselection } from './plugins/file-selection.js'
import { plugin as fileSelectionDrawerPlugin, api as fileSelectionDrawer } from './plugins/file-selection-drawer.js'
import { plugin as extractionPlugin, api as extraction } from './plugins/extraction.js'
import { plugin as servicesPlugin, api as services } from './plugins/services.js'
import { plugin as floatingPanelPlugin, api as floatingPanel } from './plugins/floating-panel.js'
import { plugin as promptEditorPlugin, api as promptEditor } from './plugins/prompt-editor.js'
import { plugin as teiWizardPlugin } from './plugins/tei-wizard.js'
import { plugin as infoPlugin, api as appInfo } from './plugins/info.js'
import { plugin as moveFilesPlugin } from './plugins/move-files.js'
import { plugin as startPlugin } from './plugins/start.js'
import { plugin as toolbarPlugin } from './plugins/toolbar.js'
import { plugin as syncPlugin, api as sync } from './plugins/sync.js'
import { plugin as accessControlPlugin, api as accessControl } from './plugins/access-control.js'
import { plugin as heartbeatPlugin, api as heartbeat } from './plugins/heartbeat.js'

/**
 * @typedef {object} PluginConfiguration
 * @property {string} name - The name of the plugin
 * @property {string[]} [deps] - The names of the plugins this plugin depends on
 */

/** @type {Array<Plugin|PluginConfiguration>} */
const plugins = [
  // class-based
  AuthenticationPlugin,

  // modules with config object
  loggerPlugin, 
  urlHashStatePlugin, 
  clientPlugin, 
  configPlugin, 
  dialogPlugin, 
  toolbarPlugin, 
  pdfViewerPlugin, 
  xmlEditorPlugin, 
  fileselectionPlugin,
  fileSelectionDrawerPlugin, 
  servicesPlugin, 
  syncPlugin, 
  extractionPlugin, 
  floatingPanelPlugin, 
  promptEditorPlugin,
  teiWizardPlugin, 
  validationPlugin, 
  infoPlugin, 
  moveFilesPlugin, 
  ssePlugin,
  accessControlPlugin, 
  heartbeatPlugin, 
  startPlugin
]

/**
 * The application state, which is often passed to the plugin endpoints
 * 
 * @typedef {object} ApplicationState
 * @property {string|null} sessionId - The session id of the particular app instance in a browser tab/window
 * @property {string|null} pdf - The document identifier for the PDF file in the viewer
 * @property {string|null} xml - The document identifier for the XML file in the editor
 * @property {string|null} diff - The document identifier for an XML file which is used to create a diff, if any
 * @property {string|null} xpath - The current xpath used to select a node in the editor
 * @property {string|null} variant - The variant filter to show only files with matching variant-id
 * @property {boolean} webdavEnabled - Wether we have a WebDAV backend on the server
 * @property {boolean} editorReadOnly - Whether the XML editor is read-only
 * @property {boolean} offline  - Whether the application is in offline mode
 * @property {object|null} user - The currently logged-in user
 * @property {string|null} collection - The collection the current document is in
 * @property {Array<object>|null} fileData - The file data loaded from the server
 * @property {Record<string, any>} ext - Extension object for plugins to store additional state properties
 * @property {ApplicationState|null} previousState - Links to the previous state object 
 */

/**
 * The initial application state
 * @type{ApplicationState}
 */
let state = {
  pdf: null,
  xml: null,
  diff: null,
  xpath: null,
  variant: null,
  webdavEnabled: false,
  editorReadOnly: false,
  offline: false,
  sessionId: null,
  user: null,
  collection: null,
  fileData: null,
  ext: {},
  previousState: null
}

//
// Application bootstrapping
//

// Create plugin manager and state manager singletons
const pluginManager = new PluginManager();
const stateManager = new StateManager();

// Create application instance
const app = new Application(pluginManager, stateManager)

// Register plugins
app.registerPlugins(plugins)

// Create authentication API export after plugin registration
export const authentication = AuthenticationPlugin.getInstance()

// Set log level after registration
await pluginManager.invoke(ep.log.setLogLevel, {level: logLevel.DEBUG})

// Compose initial application state from various sources
const persistedStateVars = (await config.get("state.persist") || [])
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
  logger.info("Getting state properties from URL hash: " + Object.keys(urlHashState).join(", "))
  Object.assign(state, urlHashState)
}

// Initialize application with final composed state
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
// Core application functions
//

/**
 * Reloads the file data from the server
 * @param {ApplicationState} state
 * @param {Object} options - Options for reloading
 * @param {boolean} [options.refresh] - Whether to force refresh of server cache
 * @returns {Promise} 
 */
async function reloadFileData(state, options = {}) {
  logger.debug("Reloading file data" + (options.refresh ? " with cache refresh" : ""))
  let data = await client.getFileList(null, options.refresh);
  if (!data || data.length === 0) {
    dialog.error("No files found")
  }
  // Create hash lookup index when fileData is loaded
  if (data && data.length > 0) {
    logger.debug('Creating hash lookup index for file data');
    createHashLookupIndex(data);
  }
  // Store fileData in state and propagate it
  return await app.updateState(state, {fileData:data})
}

//
// Legacy compatibility functions for old plugin system
//

/**
 * Legacy updateState function for backward compatibility with old plugins
 * @param {ApplicationState} currentState - The current state
 * @param {Partial<ApplicationState>} changes - Changes to apply
 * @returns {Promise<ApplicationState>} New state after changes applied
 */
async function updateState(currentState, changes = {}) {
  return await app.updateState(currentState, changes);
}

/**
 * Legacy hasStateChanged function for backward compatibility with old plugins
 * @param {ApplicationState} state - The current state
 * @param {...string} propertyNames - Property names to check for changes
 * @returns {boolean} True if any of the specified properties changed
 */
function hasStateChanged(state, ...propertyNames) {
  return stateManager.hasStateChanged(state, ...propertyNames);
}

//
// Exports
// 

// application APIs and data
export {
  app, 
  ep as endpoints, 
  pluginManager, 
  stateManager, 
  reloadFileData,
  updateState, // Legacy compatibility
  hasStateChanged // Legacy compatibility
}

// plugin APIs  
// authentication is exported earlier after plugin registration

// legacy plugin APIs
export { 
  logger, 
  dialog, 
  pdfViewer, 
  xmlEditor, 
  client, 
  config, 
  validation, 
  fileselection, 
  fileSelectionDrawer, 
  extraction,
  services, 
  sync, 
  floatingPanel, 
  promptEditor, 
  urlHash, 
  appInfo, 
  sse, 
  accessControl, 
  heartbeat 
}
