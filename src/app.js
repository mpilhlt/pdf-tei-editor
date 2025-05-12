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
import { plugin as urlHashStatePlugin } from './plugins/url-hash-state.js'
import { plugin as dialogPlugin, api as dialog } from '../plugins/dialog.js'
import { plugin as pdfViewerPlugin, api as pdfViewer } from '../plugins/pdfviewer.js'
import { plugin as xmlEditorPlugin, api as xmlEditor } from '../plugins/xmleditor.js'
import { plugin as clientPlugin, api as client } from '../plugins/client.js'
import { plugin as fileselectionPlugin, api as fileselection } from '../plugins/file-selection.js'
import { plugin as extractionPlugin, api as extraction } from '../plugins/extraction.js'
import { plugin as servicesPlugin, api as services } from '../plugins/services.js'
import { plugin as floatingPanelPlugin, api as floatingPanel } from '../plugins/floating-panel.js'
import { plugin as promptEditorPlugin, api as promptEditor } from '../plugins/prompt-editor.js'
import { plugin as teiWizardPlugin } from '../plugins/tei-wizard.js'

//import { plugin as dummyLoggerPlugin } from '../components/logger-dummy.js'

/**
 * The application state, which is passe
 * 
 * @typedef {object} ApplicationState
 * @property {string} pdfPath
 * @property {string} xnlPath
 * @property {string} diffXmlPath
 * @property {string} xpath
 */
/**
 * @type{ApplicationState}
 */
let state = {
  pdfPath: null,
  xmlPath: null,
  diffXmlPath: null,
  xpath: null,
}

const plugins = [loggerPlugin, urlHashStatePlugin, dialogPlugin, 
  pdfViewerPlugin, xmlEditorPlugin, clientPlugin, fileselectionPlugin,
  extractionPlugin, servicesPlugin, floatingPanelPlugin, promptEditorPlugin,
  teiWizardPlugin
]

// register plugins
for (const plugin of plugins) {
  console.info(`Installing '${plugin.name}' plugin`)
  pluginManager.register(plugin)
}

async function invoke(endpoint, param) {
 return await Promise.all(pluginManager.invoke(endpoint, param))
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
export { state, ep as endpoints, invoke }
export { logger, dialog, pdfViewer, xmlEditor, client,fileselection, extraction,
  services, floatingPanel, promptEditor }
