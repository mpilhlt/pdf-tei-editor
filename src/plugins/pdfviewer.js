/**
 * PDF Viewer Plugin
 */


/** @import { ApplicationState } from '../app.js' */
import { PDFJSViewer } from '../modules/pdfviewer.js'
import { invoke, logger, services, xmlEditor } from '../app.js'
import ui from '../ui.js'

/**
 * component is an instance of PDFViewer
 * @type {PDFJSViewer}
 */
const pdfViewerComponent = new PDFJSViewer('pdf-viewer')
// hide it until ready
pdfViewerComponent.hide()

/**
 * plugin API
 */
const api = pdfViewerComponent;

/**
 * component plugin
 */
const plugin = {
    name: "pdfviewer",
    install
}

export { plugin, api }
export default plugin

//
// Implementation
//

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 * @returns {Promise<void>}
 */
async function install(app) {
  app.on("change:xpath", async (value, old) => {
    // trigger auto-search if enabled, 
    const autoSearchSwitch = app.floatingPanel.getByName("switch-auto-search")
    const node = xmlEditor.selectedNode
    if (autoSearchSwitch.checked && node) {
      await services.searchNodeContentsInPdf(node)
    }
  })
  logger.info("PDFViewer plugin installed.")
  await pdfViewerComponent.isReady()
  logger.info("PDF Viewer ready.")
  pdfViewerComponent.show()
}