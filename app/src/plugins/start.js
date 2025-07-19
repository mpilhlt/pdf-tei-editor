/**
 * Plugin which hosts the start function, which is responsible for loading the documents at startup
 * Does not export any API
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { Diagnostic } from '@codemirror/lint'
 */
import ui from '../ui.js'
import { updateState, logger, services, dialog, validation, floatingPanel, urlHash, xmlEditor, client, fileselection } from '../app.js'
import { Spinner, updateUi } from '../ui.js'
import { UrlHash } from '../modules/browser-utils.js'
import { XMLEditor } from './xmleditor.js'
import { setDiagnostics } from '@codemirror/lint'

/**
 * Plugin object
 */
const plugin = {
  name: "start",
  install,
  validation: {
    result: onValidationResult
  },
  // should be the last plugin to be installed, so correctly all of the other plugins should be listed here, 
  // just using the next-to-last one for convenience
  deps: ["tei-validation"],
  start
}

export { plugin }
export default plugin


//
// Implementation
//

let spinner

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
}

/**
* Starts the application, configures plugins and the UI
* @param {ApplicationState} state
*/
async function start(state) {

  // async operations
  try {

    // update the file lists
    await fileselection.reload(state)

    ui.spinner.show('Loading documents, please wait...')

    logger.info("Configuring application state from URL")
    urlHash.updateState(state)

    // disable regular validation so that we have more control over it
    validation.configure({mode:"off"})

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
        await services.showMergeView(state, diff)
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
        validation.configure({mode: seconds > 3 ? "off": "auto"})
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

    // manually show diagnostics if validation is disabled
    xmlEditor.addEventListener(XMLEditor.EVENT_EDITOR_XML_NOT_WELL_FORMED, evt => {
      if (validation.isDisabled()) {
        let view = xmlEditor.getView()
        let diagnostic = evt.detail
        view.dispatch(setDiagnostics(view.state, [diagnostic]))
      }
    })

    // if validation is disabled, save dirty editor content
    xmlEditor.addEventListener(XMLEditor.EVENT_EDITOR_DELAYED_UPDATE, evt => {
      if (validation.isDisabled()) {
        saveIfDirty()
      } 
    })

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
 * Called when a validation has been done. 
 * Used to save the document after successful validation
 * @param {Diagnostic[]} diagnostics 
 */
async function onValidationResult(diagnostics) {
  if (diagnostics.length === 0) {
    saveIfDirty()
  }
}

/**
 * Save the current XML file if the editor is "dirty"
 */
async function saveIfDirty() {
  const filePath = String(ui.toolbar.xml.value)
  if (filePath && xmlEditor.getXmlTree() && xmlEditor.isDirty()) {
    const result = await services.saveXml(filePath)
    if (result.status == "unchanged") {
      logger.debug(`File has not changed`)
    } else {
      logger.debug(`Saved file to ${result.path}`)
    }
  }
}