/**
 * Plugin which hosts the start function, which is responsible for loading the documents at startup
 * and configures the general behavior of the application. General rule: behavior that depends solely 
 * on a particular plugin should be configured in the plugin, behavior that depends on the interplay
 * of several plugins should be configured here.
 */

/** 
 * @import { ApplicationState } from '../state.js' 
 */
import ui from '../ui.js'
import {
  endpoints as ep, app, logger, services, dialog, validation, floatingPanel, xmlEditor,
  config, authentication, heartbeat, sync
} from '../app.js'
import { Spinner, updateUi } from '../ui.js'
import { UrlHash } from '../modules/browser-utils.js'
import { notify } from '../modules/sl-utils.js'

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

  // Note: validation status widget creation moved to xmleditor plugin's start() function
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

    // update the file data
    await app.invokePluginEndpoint(ep.filedata.reload, {refresh:true})

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
        await services.load({ pdf, xml, diff })
      } catch (error) {
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
      const newState = await app.updateState({ xpath })

      // synchronize in the background
      sync.syncFiles(currentState).then(async (summary) => {
        logger.info(summary)
        if (summary && !summary.skipped) {
          await app.invokePluginEndpoint(ep.filedata.reload, {refresh:true})
        }
      })
    }

    // configure the xml editor events
    configureFindNodeInPdf()

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
 * Add behavior that looks up the content of the current node in the PDF
 */
function configureFindNodeInPdf() {
  let lastNode = null;

  // Cross-plugin coordination: Find the currently selected node's contents in the PDF
  xmlEditor.on("selectionChanged", async () => {
    // workaround for the node selection not being updated immediately
    await new Promise(resolve => setTimeout(resolve, 100)) // wait for the next tick
    // trigger auto-search if enabled and if a new node has been selected
    const autoSearchSwitch = /** @type {any} */ (ui.pdfViewer.statusbar.searchSwitch)
    const node = xmlEditor.selectedNode

    if (autoSearchSwitch && autoSearchSwitch.checked && node && node !== lastNode) {
      await services.searchNodeContentsInPdf(node)
      lastNode = node
    }
  })
}
