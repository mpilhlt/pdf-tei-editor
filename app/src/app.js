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

import pluginManager from "./modules/plugin.js"
import ep from './endpoints.js' 

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
 */
/**
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
  collection: null
}

/**
 * @typedef {object} Plugin
 * @property {string} name - The name of the plugin
 * @property {string[]} [deps] - The names of the plugins this plugin depends on
 * @property {function(ApplicationState):Promise<*>} [install] - The function to install the plugin
 * @property {function(ApplicationState):Promise<*>} [update] - The function to respond to state updates
 */

/** @type {Plugin[]} */
const plugins = [loggerPlugin, urlHashStatePlugin, clientPlugin, configPlugin, 
  dialogPlugin, toolbarPlugin, pdfViewerPlugin, xmlEditorPlugin, fileselectionPlugin,
  servicesPlugin, syncPlugin, extractionPlugin, floatingPanelPlugin, promptEditorPlugin,
  teiWizardPlugin, validationPlugin, infoPlugin, moveFilesPlugin, ssePlugin,
  authenticationPlugin, accessControlPlugin,
  /* must be the last plugin */ startPlugin]

// add all other plugins as dependencies of the start plugin, so that it is the last one to be installed
startPlugin.deps = plugins.slice(0,-1).map(p => p.name)

// register plugins
for (const plugin of plugins) {
  console.log(`Registering plugin '${plugin.name}'...`)
  pluginManager.register(plugin)
}

/**
 * Utility method to invoke plugin endpoints and await the fulfilment of any returned promises
 * @param {string} endpoint 
 * @param {*} param 
 * @param {object} [options={}] - Invoke options
 * @param {number} [options.timeout=2000] - Timeout in milliseconds
 * @returns {Promise<*>}
 */
async function invoke(endpoint, param, options = {}) {
  // get all promises (or sync results) from the endpoints
  const promises = pluginManager.invoke(endpoint, param)
    // Set up a timeout mechanism so that the app doesn't hang if a promise does not resolve quickly or ever
  const timeout = options.timeout !== undefined ? options.timeout : 2000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeout);
  
  try {
    const result = await Promise.allSettled(promises.map(async (promise) => {
      try {
        return await promise;
      } catch (error) {
        if (error.name === 'AbortError') {
          console.warn(`Plugin endpoint '${endpoint}' timed out after ${timeout}ms`);
        } else {
          console.error(`Error in plugin endpoint ${endpoint}:`, error);
        }
        throw error;
      }
    }));
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Utility method which updates the state object and invokes the endpoint to propagate the change through the other plugins
 * @param {ApplicationState} state The application state object
 * @param {Object?} changes For each change in the state, provide a key-value pair in this object. 
 * @returns {Promise<Array>} Returns an array of return values of the plugin's `update` methods
 */
async function updateState(state, changes={}) {
  Object.assign(state, changes)
  return await invoke(ep.state.update, state)
}

// 
// Application bootstrapping
//

// log level
await invoke(ep.log.setLogLevel, {level: logLevel.DEBUG})

// let the plugins install their components
await invoke(ep.install, state)

// persist the state across reloads in sessionStorage
const SESSION_STORAGE_ID = 'pdf-tei-editor.state'
const stateInSessionStorage = sessionStorage.getItem(SESSION_STORAGE_ID) || 'INVALID'
let tmpState
try {
  tmpState = JSON.parse(stateInSessionStorage)
  logger.info("Loaded state from sessionStorage")
} catch(e) {
  logger.info("Loading initial state from server")
  tmpState = await client.state()
}
updateState(state, tmpState)

// start the application 
await invoke(ep.start, state)

// Load configuration after plugins are fully initialized
const persistedStateVars = (await config.get("state.persist") || [])
persistedStateVars.push('sessionId') // the session id is always persisted

window.addEventListener('beforeunload', evt => {
  logger.debug("Saving state in sessionStorage")
  sessionStorage.setItem(SESSION_STORAGE_ID, JSON.stringify(state))
})

// URL hash params override properties
await urlHash.updateStateFromUrlHash(state)

//
// Exports
// 
export { state, ep as endpoints, invoke, updateState, pluginManager, plugins }
export { logger, dialog, pdfViewer, xmlEditor, client, config, validation, fileselection, extraction,
  services, sync, floatingPanel, promptEditor, urlHash, appInfo, sse, authentication, accessControl }
