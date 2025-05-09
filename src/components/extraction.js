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
import { appendHtml } from '../modules/browser-utils.js'


// name of the component
const componentId = "extraction"

// buttons to be added 
const buttonsHtml = `
<sl-button-group label="Extraction" name="extraction-group">
  <sl-tooltip content="Upload a new PDF and extract references">
    <sl-button name="extract-new" size="small">
      <sl-icon name="filetype-pdf"></sl-icon>
    </sl-button>
  </sl-tooltip>
  <sl-tooltip content="Extract from the current PDF into a new TEI version">
    <sl-button name="extract-current" size="small">
      <sl-icon name="clipboard2-plus"></sl-icon>
    </sl-button>
  </sl-tooltip>
</sl-button-group>
`

const dialogHtml = `
<sl-dialog label="Extract references">
  <div class="dialog-column">
    <sl-select name="ModelIndex" label="Model" size="small" help-text="Choose the model configuration used for the extraction"></sl-select>
    <sl-select name="instructionIndex" label="Instructions" size="small" help-text="Choose the instruction set that is added to the prompt"></sl-select>  
    <sl-input name="doi" label="DOI" size="small" help-text="Please enter the DOI of the document to add document metadata"></input>   
  </div>
  <sl-button slot="footer" name="cancel" variant="neutral">Cancel</sl-button>
  <sl-button slot="footer" name="submit" variant="primary">Extract</sl-button>  
</sl-dialog>
`

/**
 * component API
 */
const api = {
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

export { api , plugin }
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
  app.registerComponent(componentId, api, "extraction")

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
    let { xml } = await extractFromPDF(app.pdfPath, {doi})
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
  if (options === null) return

  app.spinner.show('Extracting references, please wait')
  try {
    let result = await app.client.extractReferences(filename, options)
    app.fileselection.reload()
    return result
  } finally {
    app.spinner.hide()
  }
}

// utilities

async function promptForExtractionOptions(options) {

  // load instructions
  const instructionsData = await app.client.loadInstructions()
  const instructions = [];

  // add dialog to DOM
  const dialog = appendHtml(dialogHtml)[0]
  
  // populate dialog
  const doiInput = dialog.querySelector('[name="doi"]')
  doiInput.value = options.doi

  // configure selectbox 
  const selectbox = dialog.querySelector('[name="instructionIndex"]')
  for (const [idx, {label, text}] of instructionsData.entries()) {
    const option = Object.assign (new SlOption, {
      value: String(idx),
      textContent: label
    })
    instructions[idx] = text.join("\n")
    selectbox.appendChild(option)
  }
  selectbox.value = "0"

  // display the dialog and await the user's response
  const formData = await new Promise(resolve => {
    // user cancels
    function cancel() {
      dialog.remove()
      resolve(null)
    }
    // user submits their input
    function submit() {
      dialog.remove()
      resolve({
        'doi': dialog.querySelector('[name="doi"]').value,
        'instructionIndex': parseInt(dialog.querySelector('[name="instructionIndex"]').value)
      })
    }

    // event listeners
    dialog.addEventListener("sl-request-close", cancel, { once: true })
    dialog.querySelector('[name="cancel"]').addEventListener("click", cancel, { once: true })
    dialog.querySelector('[name="submit"]').addEventListener("click", submit, { once: true })
    
    dialog.show()
  })

  if (formData === null) {
    // user has cancelled the form
    return null
  } 

  if (formData.doi == "" || !isDoi(formData.doi)) {
    app.dialog.error(`${doi} does not seem to be a DOI, please try again.`)
    return 
  }

  Object.assign(options, {
    doi: formData.doi,
    instructions: instructions[formData.instructionIndex]
  }) 

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