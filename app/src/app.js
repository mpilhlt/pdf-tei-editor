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
import { invoke, pluginManager } from './modules/plugin-utils.js'
import { updateState, createNewState, hasStateChanged, getChangedStateKeys, getPreviousStateValue, clearStateHistory, getStateHistorySize, updateStateExt, preserveState, getStateFromSessionStorage } from './modules/state-utils.js'
import { createHashLookupIndex } from './modules/file-data-utils.js'

// plugins
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
import { plugin as authenticationPlugin, api as authentication } from './plugins/authentication.js'
import { plugin as toolbarPlugin } from './plugins/toolbar.js'
import { plugin as syncPlugin, api as sync } from './plugins/sync.js'
import { plugin as accessControlPlugin, api as accessControl } from './plugins/access-control.js'
import { plugin as heartbeatPlugin, api as heartbeat } from './plugins/heartbeat.js'
//import { plugin as dummyLoggerPlugin } from './plugins/logger-dummy.js'

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

/**
 * @typedef {object} Plugin
 * @property {string} name - The name of the plugin
 * @property {string[]} [deps] - The names of the plugins this plugin depends on
 * @property {function(ApplicationState):Promise<*>} [install] - The function to install the plugin
 * @property {{update: function(ApplicationState):Promise<*>}} [state] - The function to update the plugin
 * @property {*} [validation]
 */

/** @type {Plugin[]} */
const plugins = [loggerPlugin, urlHashStatePlugin, clientPlugin, configPlugin, 
  dialogPlugin, toolbarPlugin, pdfViewerPlugin, xmlEditorPlugin, fileselectionPlugin,
  fileSelectionDrawerPlugin, servicesPlugin, syncPlugin, extractionPlugin, floatingPanelPlugin, promptEditorPlugin,
  teiWizardPlugin, validationPlugin, infoPlugin, moveFilesPlugin, ssePlugin,
  authenticationPlugin, accessControlPlugin, heartbeatPlugin,
  /* must be the last plugin */ startPlugin]

// add all other plugins as dependencies of the start plugin, so that it is the last one to be installed
startPlugin.deps = plugins.slice(0,-1).map(p => p.name)

// register plugins
for (const plugin of plugins) {
  console.log(`Registering plugin '${plugin.name}'...`)
  pluginManager.register(plugin)
}

// 
// Application bootstrapping
//

// log level
await invoke(ep.log.setLogLevel, {level: logLevel.DEBUG})

// let the plugins install their components
await invoke(ep.install, state)

//
// persist the state across reloads in sessionStorage
//
const persistedStateVars = (await config.get("state.persist") || [])
persistedStateVars.push('sessionId') // the session id is always persisted
let serverState = await client.state()
let sessionState = getStateFromSessionStorage();
if (sessionState) {
  logger.info("Loaded state from sessionStorage")
} else {
  logger.info("Loading initial state from server")
  sessionState = serverState
}
// special case where server state overrides saved state on reload
// this is a workaround to be fixed
sessionState.webdavEnabled = serverState.webdavEnabled
// create new state with loaded data (without notifying plugins yet)
state = createNewState(state, sessionState)

// enable automatic state preservation in sessionStorage
preserveState(true)

// URL hash params override properties (apply to state without notifying plugins yet)
const urlHashState = await urlHash.getStateFromUrlHash() 
if (urlHashState && Object.keys(urlHashState).length > 0) {
  state = createNewState(state, urlHashState)
}

// Now notify plugins with the final initial state
await updateState(state, {})  

// invoke the "start" endpoint
await invoke(ep.start)

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
  updateState(state, {fileData:data})
}

//
// Exports
// 
export { state, ep as endpoints, invoke, updateState, createNewState, hasStateChanged, getChangedStateKeys, getPreviousStateValue, clearStateHistory, getStateHistorySize, updateStateExt, preserveState, getStateFromSessionStorage, pluginManager, plugins, reloadFileData }
export { logger, dialog, pdfViewer, xmlEditor, client, config, validation, fileselection, fileSelectionDrawer, extraction,
  services, sync, floatingPanel, promptEditor, urlHash, appInfo, sse, authentication, accessControl, heartbeat }
