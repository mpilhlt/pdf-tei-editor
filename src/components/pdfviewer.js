import { PDFJSViewer } from '../modules/pdfviewer.js'
import { app, PdfTeiEditor } from '../app.js'

/**
 * component is an instance of PDFViewer
 * @type {PDFJSViewer}
 */
export const pdfViewerComponent = new PDFJSViewer('pdf-viewer')

// hide the editor until it is fully loaded
pdfViewerComponent.hide().isReady().then(()=>pdfViewerComponent.show())

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 * @returns {Promise<void>}
 */
async function install(app) {
  
  app.registerComponent('pdfviewer', pdfViewerComponent, 'pdfviewer')

  app.on("change:xpath", (value, old) => {
    console.warn(`TODO reimplement search node in PDF for  ${value}`)
        // trigger auto-search if enabled, 
        // const autoSearchSwitch = $('#switch-auto-search') // todo convert into state app
        // if (autoSearchSwitch.checked) {
        //   await app.services.searchNodeContentsInPdf(node)
        // }
  })
  console.log("PDFViewer component installed.")
  await pdfViewerComponent.isReady()
  console.log("Waiting for PDF Viewer ready...")
}

/**
 * component plugin
 */
export const pdfViewerPlugin = {
    name: "pdfviewer",
    install
}

export default pdfViewerPlugin
