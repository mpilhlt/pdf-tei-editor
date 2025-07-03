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
  state: { update }
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
  await pdfViewer.isReady()
  logger.info("PDF Viewer ready.")
  pdfViewer.show()
}

let lastNode = null; 

/**
 * @param {ApplicationState} state
 * @returns {Promise<void>}
 */
async function update(state) {

  // workaround for the node selection not being updated immediately
  await new Promise(resolve => setTimeout(resolve, 100)) // wait for the next tick

  // trigger auto-search if enabled and if a new node has been selected
  const autoSearchSwitch = ui.floatingPanel.switchAutoSearch
  const node = xmlEditor.selectedNode

  if (autoSearchSwitch.checked && node && node !== lastNode) {
      await services.searchNodeContentsInPdf(node)
      lastNode = node
  }
}