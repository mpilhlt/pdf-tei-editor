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
  <sl-button name="extract-new">New</sl-button>
  <sl-button name="extract-current">Current</sl-button>
`

/**
 * component API
 */
const cmp = {
  extractFromCurrentPDF,
  extractFromNewPdf,
  extractFromPDF
}


/**
 * component plugin
 */
const plugin = {
  name: componentId,
  install
}

export { cmp as extractionComponent, plugin as extractionPlugin }
export default plugin

//
// Implementation
//

// API

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
function install(app) {
  app.registerComponent(componentId, cmp, "extraction")

  // install controls on menubar
  const div = document.createElement("div")
  div.innerHTML = html.trim()
  div.childNodes.foreEach(elem => app.commandbar.add(elem))

  // load new document
  cmp.clicked('extract-new', extractFromNewPdf)

  // extract from current PDF
  cmp.clicked('extract-current', onClickExtractBtn)
  
  app.logger.info("Prompt editor component installed.")
}

/**
 * Extract references from the currently loaded PDF
 */
async function extractFromCurrentPDF() {
  let doi;
  try {
    doi = getDoiFromXml()
  } catch (error) {
    console.warn("Cannot get DOI from document:", error.message)
  }
  try {
    doi = doi || getDoiFromFilenameOrUserInput(app.pdfPath)
    let { xml } = await extractFromPDF(app.pdfPath, doi)
    await reloadFileData()
    await app.services.showMergeView(xml)
  } catch (error) {
    console.error(error)
  }
}


/**
 * Upload a new PDF and extract from it
 */
async function extractFromNewPdf() {
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
 * Extracts references from the given PDF file
 * @param {string} filename The name of the PDF file
 * @param {string} doi The DOI of the PDF file
 * @returns {Promise<{xml, pdf}>} An object with path to the xml and pdf files
 * @throws {Error} If the DOI is not valid
 */
async function extractFromPDF(filename, doi = "") {
  if (!filename) {
    throw new Error("No filename given")
  }
  app.spinner.show('Extracting references, please wait')
  try {
    let result = await app.client.extractReferences(filename, doi)
    app.commandbar.update()
    return result
  } finally {
    app.spinner.hide()
  }
}


// Event Listeners





// utilities

function getDoiFromXml() {
  return app.xmleditor.getDomNodeByXpath("//tei:teiHeader//tei:idno[@type='DOI']")?.textContent
}

function getDoiFromFilenameOrUserInput(filename) {
  if (filename.match(/^10\./)) {
    // treat as a DOI-like filename
    // do we have URL-encoded filenames?
    doi = filename.slice(0, -4)
    if (decodeURIComponent(doi) !== doi) {
      // filename is URL-encoded DOI
      doi = decodeURIComponent(doi)
    } else {
      // custom decoding 
      doi = doi.replace(/_{1,2}/, '/').replaceAll(/__/g, '/')
    }
  }
  const msg = "Please enter the DOI of the PDF. This will add metadata to the generated TEI document"
  doi = prompt(msg, doi)
  if (doi === null) {
    // user cancelled
    throw new Error("User cancelled DOI input")
  } else if (!isDoi(doi)) {
    window.app.dialog.error(`${doi} does not seem to be a DOI, please try again.`)
    throw new Error("Invalid DOI")
  }
}


function isDoi(doi) {
  // from https://www.crossref.org/blog/dois-and-matching-regular-expressions/
  const DOI_REGEX = /^10.\d{4,9}\/[-._;()\/:A-Z0-9]+$/i  
  return Boolean(doi.match(DOI_REGEX)) 
}