/**
 * Plugin which hosts the start function, which is responsible for loading the documents at startup
 * and configures the general behavior of the application. General rule: behavior that depends solely 
 * on a particular plugin should be configured in the plugin, behavior that depends on the interplay
 * of several plugins should be configured here.
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { Diagnostic } from '@codemirror/lint'
 */
import ui from '../ui.js'
import {
  updateState, logger, services, dialog, validation, floatingPanel, xmlEditor,
  config, authentication, heartbeat, reloadFileData, sync
} from '../app.js'
import { PanelUtils } from '../modules/panels/index.js'
import { Spinner, updateUi } from '../ui.js'
import { UrlHash } from '../modules/browser-utils.js'
import { setDiagnostics } from '@codemirror/lint'
import { notify } from '../modules/sl-utils.js'
import { saveIfDirty } from './xmleditor.js' // TODO: needs to be implemented without tight coupling

/**
 * Plugin object
 * dependencies are automatically set to all other plugins, so that it is the last one to be installed
 */
const plugin = {
  name: "start",
  install,
  start,
  state: {
    update
  }
}

export { plugin }
export default plugin


//
// Implementation
//

let spinner
let validationStatusWidget = null

/**@type {ApplicationState} */
let currentState;

/**
 * Invoked for plugin installation
 * @param {ApplicationState} state 
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)
  // spinner/blocker
  spinner = new Spinner
  // @ts-ignore
  spinner.setAttribute('name', "spinner")
  document.body.appendChild(spinner)
  updateUi()

  // Create validation status widget
  validationStatusWidget = PanelUtils.createText({
    text: 'Invalid XML',
    variant: 'error'
  })
}

/**
 * Observes state changes for UI updates
 * @param {ApplicationState} state
 */
async function update(state) {
  currentState = state
}

/**
* Starts the application, configures plugins and the UI
*/
async function start() {

  // async operations
  try {

    // Authenticate user, otherwise we don't proceed further
    const userData = await authentication.ensureAuthenticated()
    logger.info(`${userData.fullname} has logged in.`)
    notify(`Welcome back, ${userData.fullname}!`)

    // load config data
    await config.load()

    ui.spinner.show('Loading documents, please wait...')

    // update the file lists
    await reloadFileData(currentState, { refresh: true })

    // disable regular validation so that we have more control over it
    validation.configure({ mode: "off" })

    // get document paths from URL hash 
    // @ts-ignore
    const pdf = currentState.pdf || null
    const xml = currentState.xml || null
    const diff = currentState.diff

    if (pdf !== null) {
      // lod the documents
      try {
        await services.load(currentState, { pdf, xml, diff })
      } catch(error) {
        dialog.error(error.message)
        logger.critical(error.message)
      }
    }

    // two alternative initial states:
    // a) if the diff param was given and is different from the xml param, show a diff/merge view 
    // b) if no diff, try to validate the document and select first match of xpath expression
    if (diff && diff !== xml) {
      // a) load the diff view
      try {
        await services.showMergeView(currentState, diff)
      } catch (error) {
        logger.warn("Error loading diff view: " + error.message)
      }
    } else {
      // b) validation & xpath selection

      // measure how long it takes to validate the document
      const startTime = new Date().getTime();
      services.validateXml().then(() => {
        const endTime = new Date().getTime();
        const seconds = Math.round((endTime - startTime) / 1000);
        // disable validation if it took longer than 3 seconds on slow servers
        logger.info(`Validation took ${seconds} seconds${seconds > 3 ? ", disabling it." : "."}`)
        validation.configure({ mode: seconds > 3 ? "off" : "auto" })
      })

      // the xpath of the (to be) selected node in the xml editor, setting the state triggers the selection
      const xpath = UrlHash.get("xpath") || ui.floatingPanel.xpath.value

      // update the UI
      await updateState(currentState, { xpath })

      // synchronize in the background
      sync.syncFiles(currentState).then(async (summary) => {
        logger.info(summary)
        if (summary && !summary.skipped) {
          await reloadFileData(currentState, { refresh: true })
        }
      })
    }

    // configure the xml editor events
    configureXmlEditor()

    // Heartbeat mechanism for file locking and offline detection
    heartbeat.start(currentState, await config.get('heartbeat.interval', 10));

    // finish initialization
    ui.spinner.hide()
    floatingPanel.show()
    xmlEditor.setLineWrapping(true)
    logger.info("Application ready.")

  } catch (error) {
    ui.spinner.hide();
    dialog.error(error.message)
    throw error
  }
}

/**
 * Configure the xmleditor's behavior by responding to 
 * events
 */
function configureXmlEditor() {
  // Find the currently selected node's contents in the PDF
  xmlEditor.on("selectionChanged", searchNodeContents)

  // manually show diagnostics if validation is disabled
  xmlEditor.on("editorXmlNotWellFormed", diagnostics => {
    if (validation.isDisabled()) {
      let view = xmlEditor.getView()
      try {
        // Validate diagnostic positions before setting
        const validDiagnostics = diagnostics.filter(d => {
          return d.from >= 0 && d.to > d.from && d.to <= view.state.doc.length
        })
        view.dispatch(setDiagnostics(view.state, validDiagnostics))
      } catch (error) {
        logger.warn("Error setting diagnostics: " + error.message)
        // Clear diagnostics on error
        try {
          view.dispatch(setDiagnostics(view.state, []))
        } catch (clearError) {
          logger.warn("Error clearing diagnostics: " + clearError.message)
        }
      }
    }
  })

  // save dirty editor content after an update
  xmlEditor.on("editorUpdateDelayed", async () => await saveIfDirty())

  // xml vaidation events
  xmlEditor.on("editorXmlNotWellFormed", diagnostics => {
    console.warn("XML is not well-formed", diagnostics)
    try {
      // Validate diagnostic positions before setting
      const view = xmlEditor.getView()
      const validDiagnostics = diagnostics.filter(d => {
        return d.from >= 0 && d.to > d.from && d.to <= view.state.doc.length
      })
      view.dispatch(setDiagnostics(view.state, validDiagnostics))
    } catch (error) {
      logger.warn("Error setting XML not well-formed diagnostics: " + error.message)
    }
    // Show validation error in statusbar
    if (validationStatusWidget && !validationStatusWidget.isConnected) {
      ui.xmlEditor.statusbar.add(validationStatusWidget, 'left', 5)
    }
    // @ts-ignore
    ui.xmlEditor.querySelector(".cm-content").classList.add("invalid-xml")
  })
  xmlEditor.on("editorXmlWellFormed", async () => {
    // @ts-ignore
    ui.xmlEditor.querySelector(".cm-content").classList.remove("invalid-xml")
    try {
      xmlEditor.getView().dispatch(setDiagnostics(xmlEditor.getView().state, []))
    } catch (error) {
      logger.warn("Error clearing diagnostics on well-formed XML: " + error.message)
    }
    // Remove validation error from statusbar
    if (validationStatusWidget && validationStatusWidget.isConnected) {
      ui.xmlEditor.statusbar.removeById(validationStatusWidget.id)
    }
    // Save if dirty now that XML is valid again
    await saveIfDirty()
  })
}

/**
 * Called when the selection changes in the xmleditor
 * so that the content of the selected node is searched
 * in the PDF viewer
 */
let lastNode = null;
async function searchNodeContents() {
  // workaround for the node selection not being updated immediately
  await new Promise(resolve => setTimeout(resolve, 100)) // wait for the next tick
  // trigger auto-search if enabled and if a new node has been selected
  const autoSearchSwitch = /** @type {any} */ (ui.pdfViewer.statusbar.searchSwitch)
  const node = xmlEditor.selectedNode

  if (autoSearchSwitch && autoSearchSwitch.checked && node && node !== lastNode) {
    await services.searchNodeContentsInPdf(node)
    lastNode = node
  }
}

