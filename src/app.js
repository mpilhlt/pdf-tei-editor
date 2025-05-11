/**
 * PDF-TEI-Editor (working title)
 * 
 * @author Christian Boulanger (@cboulanger), Max Planck Institute for Legal History and Legal Theory
 * @license 
 */


import pluginManager from "./modules/plugin.js"
import {default as loggerPlugin, api as loggerApi, logLevel} from './plugins/logger.js'
import urlHashStatePlugin from './plugins/url-hash-state.js'

import ep from './endpoints.js'


// import { plugin as dialogPlugin, api as dialogApi } from '../plugins/dialog.js'
// import { plugin as pdfViewerPlugin, api as pdfViewerApi } from '../plugins/pdfviewer.js'
// import { plugin as xmlEditorPlugin, api as xmlEditorApi } from '../plugins/xmleditor.js'
// import { plugin as clientPlugin, api as clientApi } from '../plugins/client.js'
// import { plugin as commandBarPlugin, api as commandBarApi } from '../plugins/command-bar.js'
// import { plugin as fileselectionPlugin, api as fileselectionApi } from '../plugins/file-selection.js'
// import { plugin as extractionPlugin, api as extractionApi } from '../plugins/extraction.js'
// import { plugin as servicesPlugin, api as servicesApi } from '../plugins/services.js'
// import { plugin as floatingPanelPlugin, api as floatingPanelApi } from '../plugins/floating-panel.js'
// import { plugin as promptEditorPlugin, api as promptEditorApi } from '../plugins/prompt-editor.js'
// import { plugin as teiWizardPlugin } from '../plugins/tei-wizard.js'

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

const plugins = [loggerPlugin, urlHashStatePlugin]

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
