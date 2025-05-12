/**
 * This implements the UI and the services for extracting references from the current or a new PDF
 */
/** @import { ApplicationState } from '../app.js' */
import { invoke, updateState,  endpoints, logger, client, services, dialog, fileselection,  xmlEditor} from '../app.js'
import { appendHtml } from '../modules/browser-utils.js'
import ui from '../ui.js'

// name of the component
const pluginId = "extraction"

// buttons to be added 
const buttonsHtml = `
<sl-button-group label="Extraction" name="extractionActions">
  <sl-tooltip content="Upload a new PDF and extract references">
    <sl-button name="extractNew" size="small">
      <sl-icon name="filetype-pdf"></sl-icon>
    </sl-button>
  </sl-tooltip>
  <sl-tooltip content="Extract from the current PDF into a new TEI version">
    <sl-button name="extractCurrent" size="small">
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
 * plugin API
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
  deps: ['pdf-tei-editor'],
  name: pluginId,
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
 * @param {ApplicationState} state
 */
function install(state) {

  // install controls on menubar
  const div = document.createElement("div")
  div.innerHTML = buttonsHtml.trim()
  div.childNodes.forEach(elem => ui.toolbar.appendChild(elem))

  // add event listeners
  ui.toolbar.extractionActions.extractNew.addEventListener('click', () => extractFromNewPdf(state))
  ui.toolbar.extractionActions.extractCurrent.addEventListener('click', () => extractFromCurrentPDF(state))
}

/**
 * Extract references from the currently loaded PDF
 * @param {ApplicationState} state
 */
async function extractFromCurrentPDF(state) {
  let doi;
  try {
    doi = getDoiFromXml()
  } catch (error) {
    console.warn("Cannot get DOI from document:", error.message)
  }
  try {
    doi = doi || getDoiFromFilename(state.pdfPath)
    let { xml } = await extractFromPDF(state.pdfPath, {doi})
    await services.showMergeView(xml)
  } catch (error) {
    console.error(error)
  }
}

/**
 * Upload a new PDF and extract from it
 * @param {ApplicationState} state
 */
async function extractFromNewPdf(state) {
  try {
    const { type, filename } = await client.uploadFile();
    if (type !== "pdf") {
      dialog.error("Extraction is only possible from PDF files")
      return
    }

    const doi = getDoiFromFilename(filename)
    const { xml, pdf } = await extractFromPDF(filename, {doi})
    await load({ xml, pdf })

  } catch (error) {
    dialog.error(error.message)
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

  ui.spinner.show('Extracting references, please wait')
  try {
    let result = await client.extractReferences(filename, options)
    await fileselection.reload()  // todo uncouple
    return result
  } finally {
    ui.spinner.hide()
  }
}

// utilities

async function promptForExtractionOptions(options) {

  // load instructions
  const instructionsData = await client.loadInstructions()
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
    dialog.error(`${doi} does not seem to be a DOI, please try again.`)
    return 
  }

  Object.assign(options, {
    doi: formData.doi,
    instructions: instructions[formData.instructionIndex]
  }) 

  return options
}

function getDoiFromXml() {
  return xmlEditor.getDomNodeByXpath("//tei:teiHeader//tei:idno[@type='DOI']")?.textContent
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