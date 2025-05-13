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
import { plugin as validationPlugin, api as validation } from './plugins/validation.js'
import { plugin as clientPlugin, api as client } from './plugins/client.js'
import { plugin as fileselectionPlugin, api as fileselection } from './plugins/file-selection.js'
import { plugin as extractionPlugin, api as extraction } from './plugins/extraction.js'
import { plugin as servicesPlugin, api as services } from './plugins/services.js'
import { plugin as floatingPanelPlugin, api as floatingPanel } from './plugins/floating-panel.js'
import { plugin as promptEditorPlugin, api as promptEditor } from './plugins/prompt-editor.js'
import { plugin as teiWizardPlugin } from './plugins/tei-wizard.js'

//import { plugin as dummyLoggerPlugin } from './plugins/logger-dummy.js'

/**
 * The application state, which is often passed to the plugin endpoints
 * 
 * @typedef {object} ApplicationState
 * @property {string?} pdfPath - The path to the PDF file in the viewer
 * @property {string?} xmlPath - The path to the XML file in the editor
 * @property {string?} diffXmlPath - The path to an XML file which is used to create a diff, if any
 * @property {string?} xpath - The current xpath used to select a node in the editor
 */
/**
 * @type{ApplicationState}
 */
let state = {
  pdfPath: null,
  xmlPath: null,
  diffXmlPath: null,
  xpath: null
}

const plugins = [loggerPlugin, urlHashStatePlugin, dialogPlugin, 
  pdfViewerPlugin, xmlEditorPlugin, validationPlugin, clientPlugin, fileselectionPlugin,
  extractionPlugin, servicesPlugin, floatingPanelPlugin, promptEditorPlugin,
  teiWizardPlugin
]

// register plugins
for (const plugin of plugins) {
  console.info(`Installing '${plugin.name}' plugin`)
  pluginManager.register(plugin)
}

/**
 * Utility method to invoke plugin endpoints and await the fulfilment of any returned promises
 * @param {string} endpoint 
 * @param {*} param 
 * @returns {Promise<*>}
 */
async function invoke(endpoint, param) {
 return await Promise.all(pluginManager.invoke(endpoint, param))
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

// let the plugins install their components
await invoke(ep.install, state)

// start the application 
await invoke(ep.start, state)

//
// Exports
// 
export { state, ep as endpoints, invoke, updateState }
export { logger, dialog, pdfViewer, xmlEditor, client, validation, fileselection, extraction,
  services, floatingPanel, promptEditor, urlHash }
