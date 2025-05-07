/**
 * This implements the UI for extracting references from the current or a new PDF
 */

import SlDialog from '@shoelace-style/shoelace/dist/components/dialog/dialog.js'
import SlButton from '@shoelace-style/shoelace/dist/components/button/button.js'
import SlDropdown from '@shoelace-style/shoelace/dist/components/dropdown/dropdown.js'
import SlMenu from '@shoelace-style/shoelace/dist/components/menu/menu.js'
import SlMenuItem from '@shoelace-style/shoelace/dist/components/menu-item/menu-item.js'
import SlTextarea from '@shoelace-style/shoelace/dist/components/textarea/textarea.js'
import SlInput from '@shoelace-style/shoelace/dist/components/input/input.js'

import { app, PdfTeiEditor } from '../app.js'


// name of the component
const componentId = "extractionUi"

// add prompt-editor in a dialog 
const html = `
  <span>Extract:</span> 
  <button name="load">New</button>
  <button name="extract">Current</button>
`
const div = document.createElement("div")
div.innerHTML = html.trim()
document.body.appendChild(div.firstChild)

/**
 * component API
 */
const cmp = {

}


/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
function install(app) {
  app.registerComponent(componentId, cmp, "extraction")

  // load new document
  cmp.clicked('load', onClickLoadDocument)

  // extract from current PDF
  cmp.clicked('extract', onClickExtractBtn)
  app.logger.info("Prompt editor component installed.")
}

/**
 * component plugin
 */
const plugin = {
  name: componentId,
  install
}

export { cmp as extractionUiComponent, plugin as extractionUiPlugin }
export default plugin

//
// Implementation
//

// API



// Event Listeners

/**
 * Called when the "Load" button is executed
 */
async function onClickLoadDocument() {
  try {
    const { type, filename } = await app.client.uploadFile();
    switch (type) {
      case "xml":
        window.app.dialog.error("Loading XML documents not implemented yet.")
        break
      case "pdf":
        try {
          const doi = getDoiFromFilenameOrUserInput(filename)
          const { xml, pdf } = await extractFromPDF(filename, doi)
          await load({ xml, pdf })
        } catch (error) {
          console.error(error)
        }

        break;
    }
  } catch (error) {
    console.error('Error uploading file:', error);
  }
}

/**
 * Called when the "Extract" button is executed
 */
async function onClickExtractBtn() {
  let doi;
  try {
    doi = app.services.getDoiFromXml()
  } catch (error) {
    console.warn("Cannot get DOI from document:", error.message)
  }
  try {
    doi = doi || app.services.getDoiFromFilenameOrUserInput(app.pdfPath)
    let { xml } = await app.services.extractFromPDF(app.pdfPath, doi)
    await reloadFileData()
    await app.services.showMergeView(xml)
  } catch (error) {
    console.error(error)
  }
}