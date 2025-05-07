/**
 * This implements the UI and the services for extracting references from the current or a new PDF
 */

import SlDialog from '@shoelace-style/shoelace/dist/components/dialog/dialog.js'
import SlButton from '@shoelace-style/shoelace/dist/components/button/button.js'
import SlButtonGroup from '@shoelace-style/shoelace/dist/components/button-group/button-group.js'
import SlTextarea from '@shoelace-style/shoelace/dist/components/textarea/textarea.js'
import SlInput from '@shoelace-style/shoelace/dist/components/input/input.js'
import SlSelect from '@shoelace-style/shoelace/dist/components/select/select.js'
import SlOption from '@shoelace-style/shoelace/dist/components/option/option.js'

import { app, PdfTeiEditor } from '../app.js'
import { getDescendantByName, appendHtml } from '../modules/browser-utils.js'


// name of the component
const componentId = "extraction"

// buttons to be added 
const buttonsHtml = `
<sl-button-group label="Extraction" name="extraction-group">
  <sl-button name="extract-new" size="small">New</sl-button>
  <sl-button name="extract-current" size="small">Current</sl-button>
</sl-button-group>
`

const dialogHtml = `
<sl-dialog label="Extract references">
  <form>
    <sl-input name="doi" label="DOI" help-text="Please enter the DOI of the document to add document metadata" name="doi"></input>
    <sl-select name="instructions" label="Instructions" help-text="Choose the instruction set that is added to the prompt"><sl-select> 
    <sl-button slot="footer" name="cancel" variant="neutral">Cancel</sl-button>
    <sl-button slot="footer" name="submit" variant="primary">Extract</sl-button>  
  </form>
</sl-dialog>
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

  const bar = app.commandbar;

  // install controls on menubar
  const controls = document.createElement("div")
  controls.innerHTML = buttonsHtml.trim()
  controls.childNodes.forEach(elem => bar.add(elem))

  // add event listeners
  bar.onClick('extract-new', extractFromNewPdf)
  bar.onClick('extract-current', extractFromCurrentPDF)

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
    doi = doi || getDoiFromFilename(app.pdfPath)
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
    if (type !== "pdf") {
      app.dialog.error("Extraction is only possible from PDF files")
      return
    }

    const doi = getDoiFromFilename(filename)
    const { xml, pdf } = await extractFromPDF(filename, {doi})
    await load({ xml, pdf })

  } catch (error) {
    app.dialog.error(error.message)
    console.error(error);
  }
}

/**
 * Extracts references from the given PDF file
 * @param {string} filename The name of the PDF file
 * @param {{doi:string, instructions:string}?} options Optional default option object passed to the extraction service,
 * user will be prompted to choose own ones.
 * @returns {Promise<{xml, pdf}>} An object with path to the xml and pdf files
 * @throws {Error} If the DOI is not valid
 */
async function extractFromPDF(filename, options = {}) {
  if (!filename) {
    throw new Error("No filename given")
  }

  // get DOI and instructions from user
  options = await promptForExtractionOptions(options)

  app.spinner.show('Extracting references, please wait')
  try {
    let result = await app.client.extractReferences(filename, options)
    app.commandbar.update()
    return result
  } finally {
    app.spinner.hide()
  }
}

// utilities

async function promptForExtractionOptions(options) {

  // add dialog to DOM
  /** @type {SlDialog} */
  const dialog = appendHtml(dialogHtml)[0]
  
  // populate dialog
  /** @type {SlInput} */
  const doiInput = getDescendantByName(dialog, "doi")
  doiInput.value = options.doi

  // configure selectbox 
  /** @type {SlSelect} */
  const selectbox = getDescendantByName(dialog, 'instructions')
  const instrFromServer = await app.client.loadInstructions()
  instructions = Array.isArray(instructions) ? instructions.concat(instrFromServer) : instrFromServer
  for (const {label, text} of options.instructions) {
    const slOption = new SlOption()
    slOption.value = text.join("\n") // the instruction text is the value
    slOption.textContent = label // the instruction label is also the option label 
    selectbox.appendChild(slOption)
  }

  // display the dialog and await the user's response
  options = await new Promise(resolve => {
    // user cancels
    function cancel() {
      dialog.remove()
      resolve(null)
    }
    // user submits their input

    // todo : use proper FormData()
    // see  https://shoelace.style/components/select#lazy-loading-options

    function submit() {
      dialog.remove()
      resolve({
        doi: doiInput.value,
        instructions: selectbox.value
      })
    }
    // event listeners
    dialog.addEventListener("sl-request-close", cancel, { once: true })
    getDescendantByName(dialog, "cancel").addEventListener("click", cancel, { once: true })
    getDescendantByName(dialog, "submit").addEventListener("click", submit, { once: true })
    
    dialog.show()
  })

  if (options === null) {
    // user has cancelled the form
    return
  } 

  if (options.doi !== "" && !isDoi(options.doi)) {
    app.dialog.error(`${doi} does not seem to be a DOI, please try again.`)
    return 
  }

  return options
}

function getDoiFromXml() {
  return app.xmleditor.getDomNodeByXpath("//tei:teiHeader//tei:idno[@type='DOI']")?.textContent
}

function getDoiFromFilename(filename) {
  let doi = null
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
  if (isDoi(doi)) {
    return doi
  }
  return null
}


function isDoi(doi) {
  // from https://www.crossref.org/blog/dois-and-matching-regular-expressions/
  const DOI_REGEX = /^10.\d{4,9}\/[-._;()\/:A-Z0-9]+$/i
  return Boolean(doi.match(DOI_REGEX))
}