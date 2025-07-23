/**
 * PDF-TEI-Editor (working title)
 * 
 * @author Christian Boulanger (@cboulanger), Max Planck Institute for Legal History and Legal Theory
 * @license 
 */

import pluginManager from "./modules/plugin.js"
import ep from './endpoints.js'

// plugins
import { plugin as loggerPlugin, api as logger, logLevel} from './plugins/logger.js'
import { plugin as urlHashStatePlugin, api as urlHash } from './plugins/url-hash-state.js'
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
//import { plugin as dummyLoggerPlugin } from './plugins/logger-dummy.js'

/**
 * The application state, which is often passed to the plugin endpoints
 * 
 * @typedef {object} ApplicationState
 * @property {string|null} pdfPath - The path to the PDF file in the viewer
 * @property {string|null} xmlPath - The path to the XML file in the editor
 * @property {string|null} diffXmlPath - The path to an XML file which is used to create a diff, if any
 * @property {string|null} xpath - The current xpath used to select a node in the editor
 * @property {boolean} webdavEnabled - Wether we have a WebDAV backend on the server
 * @property {boolean} editorReadOnly - Whether the XML editor is read-only
 * @property {boolean} offline  - Whether the application is in offline mode
 */
/**
 * @type{ApplicationState}
 */
let state = {
  pdfPath: null,
  xmlPath: null,
  diffXmlPath: null,
  xpath: null,
  webdavEnabled: false,
  editorReadOnly: false,
  offline: false
}

/**
 * @typedef {object} Plugin
 * @property {string} name - The name of the plugin
 * @property {string[]} deps - The names of the plugins this plugin depends on
 * @property {function(ApplicationState):Promise<void>} install - The function to install the plugin
 */

/** @type {Plugin[]} */
const plugins = [loggerPlugin, urlHashStatePlugin, dialogPlugin,
  pdfViewerPlugin, xmlEditorPlugin, clientPlugin, fileselectionPlugin,
  servicesPlugin, extractionPlugin, floatingPanelPlugin, promptEditorPlugin,
  teiWizardPlugin, validationPlugin, infoPlugin, moveFilesPlugin,  
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
 * @returns {Promise<*>}
 */
async function invoke(endpoint, param) {
  const promises = pluginManager.invoke(endpoint, param)
  const result = await Promise.all(promises)
  return result
}

/**
 * Utility method which updates the state object and invokes the endpoint to propagate the change through the other plugins
 * @param {ApplicationState} state The application state object
 * @param {Object?} changes For each change in the state, provide a key-value pair in this object. 
 * @returns {Promise<void>}
 */
async function updateState(state, changes={}) {
  Object.assign(state, changes)
  return await invoke(ep.state.update, state)
}

// log level
await invoke(ep.log.setLogLevel, {level: logLevel.DEBUG})

// get the server-side state 
const server_state = await client.state()
Object.assign(state, server_state)

// let the plugins install their components
await invoke(ep.install, state)

// start the application 
await invoke(ep.start, state)

//
// Exports
// 
export { state, ep as endpoints, invoke, updateState, pluginManager, plugins }
export { logger, dialog, pdfViewer, xmlEditor, client, validation, fileselection, extraction,
  services, floatingPanel, promptEditor, urlHash, appInfo }
