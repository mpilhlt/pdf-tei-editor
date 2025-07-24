/**
 * PDF Viewer Plugin
 */

/** @import { ApplicationState } from '../app.js' */
import { PDFJSViewer } from '../modules/pdfviewer.js'
import { logger, services, xmlEditor } from '../app.js'
import ui from '../ui.js'

/**
 * Expose the PDFViewer API
 * @type {PDFJSViewer}
 */
const pdfViewer = new PDFJSViewer('pdf-viewer')

// hide it until ready
pdfViewer.hide()


/**
 * plugin object
 */
const plugin = {
  name: "pdfviewer",
  install,
  //state: { update }
}

export { plugin, pdfViewer as api }
export default plugin

//
// Implementation
//

/**
 * @param {ApplicationState} state
 * @returns {Promise<void>}
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)
  await pdfViewer.isReady()
  logger.info("PDF Viewer ready.")
  pdfViewer.show()
}



/**
 * @param {ApplicationState} state
 * @returns {Promise<void>}
 */
//async function update(state) {}
