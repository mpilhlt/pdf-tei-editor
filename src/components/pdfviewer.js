import { PDFJSViewer } from '../modules/pdfviewer.js'
import { App } from '../modules/app.js'

/**
 * component is an instance of PDFViewer
 * @type {PDFJSViewer}
 */
export const pdfViewerComponent = new PDFJSViewer('pdf-viewer')

// hide the editor until it is fully loaded
pdfViewerComponent.hide().isReady().then(()=>pdfViewerComponent.show())

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {App} app The main application
 */
function start(app) {
  console.log("PDFViewer plugin installed.")
  app.registerComponent('pdfviewer', pdfViewerComponent, 'pdfviewer')
}

/**
 * component plugin
 */
export const pdfViewerPlugin = {
    name: "pdfviewer",
    app: { start }
}

export default pdfViewerPlugin
