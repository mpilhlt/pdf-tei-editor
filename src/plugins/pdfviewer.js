/**
 * PDF Viewer Plugin
 */

/** @import { ApplicationState } from '../app.js' */
import { PDFJSViewer } from '../modules/pdfviewer.js'
import { invoke, updateState, logger, services, xmlEditor } from '../app.js'
import ui from '../ui.js'

/**
 * Expose the PDFViewer API
 * @type {PDFJSViewer}
 */
const api = new PDFJSViewer('pdf-viewer')

// hide it until ready
api.hide()


/**
 * plugin object
 */
const plugin = {
  name: "pdfviewer",
  install,
  state: { update }
}

export { plugin, api }
export default plugin

//
// Implementation
//

/**
 * @param {ApplicationState} state
 * @returns {Promise<void>}
 */
async function install(state) {
  await api.isReady()
  logger.info("PDF Viewer ready.")
  api.show()
}

let lastNode = null; 

/**
 * @param {ApplicationState} state
 * @returns {Promise<void>}
 */
async function update(state) {
  // trigger auto-search if enabled and if a new node has been selected
  const autoSearchSwitch = ui.floatingPanel.switchAutoSearch
  const node = xmlEditor.selectedNode
  if (autoSearchSwitch.checked && node && node !== lastNode) {
    await services.searchNodeContentsInPdf(node)
    lastNode = node
  }
}