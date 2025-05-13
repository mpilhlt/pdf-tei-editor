/**
 * The main application plugin, which is responsible for loading the documents at startup
 */

/** @import { ApplicationState } from '../app.js' */
import ui from '../ui.js'
import ep from '../endpoints.js'
import { updateState,  logger, services, dialog, validation, floatingPanel, urlHash } from '../app.js'
import { Spinner } from '../ui.js'
import { UrlHash } from '../modules/browser-utils.js'

// plugin name
const name = "pdf-tei-editor"

/**
 * The plugin API
 */
const api = {

}


/**
 * Plugin object
 */
const plugin = {
  name,
  deps: ['logger','xmleditor', 'pdfviewer', 'services'],
  start
}

export { plugin, api }
export default plugin


//
// Implementation
//

let spinner

/**
 * Invoked for plugin installation
 * @param {ApplicationState} state 
 */
function install(state) {
  // spinner/blocker
  spinner = new Spinner
  // @ts-ignore
  spinner.name = "spinner"
  document.body.appendChild(spinner)
}

/**
* Starts the application, configures plugins and the UI
* @param {ApplicationState} state
*/
async function start(state) {

  spinner.show('Loading documents, please wait...')

  // async operations
  try {

    logger.info("Configuring application state from URL")
    urlHash.updateState(state)

    // disable regular validation so that we have more control over it
    validation.disableValidation(true)

    // get document paths from URL hash or from the first entry of the selectboxes
    // @ts-ignore
    const defaultFile = ui.toolbar.pdf.firstChild.dataset
    const pdf = state.pdfPath || defaultFile.pdf
    const xml = state.xmlPath || defaultFile.xml
    const diff = state.diffXmlPath

    // lod the documents
    await services.load(state, { pdf, xml, diff })

    // two alternative initial states:
    // a) if the diff param was given and is different from the xml param, show a diff/merge view 
    // b) if no diff, try to validate the document and select first match of xpath expression
    if (diff && diff !== xml) {
      // a) load the diff view
      try {
        await services.showMergeView(diff)
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
        validation.disableValidation(seconds > 3)
      })

      // the xpath of the (to be) selected node in the xml editor, setting the state triggers the selection
      const xpath = UrlHash.get("xpath")
      if (xpath) {
        state.xpath = xpath
      } else {
        state.xpath = ui.floatingPanel.xpath.value
      }
      // update the UI
      updateState(state)
    }

    // finish initialization
    spinner.hide()
    floatingPanel.show()
    logger.info("Application ready.")

  } catch (error) {
    spinner.hide();
    dialog.error(error.message)
    throw error
  }
}