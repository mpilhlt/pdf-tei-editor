/**
 * This implements the UI and the services for extracting references from the current or a new PDF
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlButton, SlButtonGroup, SlInput } from '../ui.js'
 */
import { client, services, dialog, fileselection, xmlEditor, updateState } from '../app.js'
import { SlSelect, SlOption, appendHtml } from '../ui.js'
import ui from '../ui.js'

/**
 * plugin API
 */
const api = {
  extractFromCurrentPDF,
  extractFromNewPdf,
  extractFromPDF
}

/**
 * plugin object
 */
const plugin = {
  name: "extraction",
  deps: ['services'],
  install
}

export { api, plugin }
export default plugin

//
// UI
//

/**
 * Extraction actions button group
 * @typedef {object} extractionActionsComponent
 * @property {SlButtonGroup} self
 * @property {SlButton} extractNew 
 * @property {SlButton} extractCurrent
 * @property {SlButton} editInstructions - added by prompt-editor plugin
 */
const buttonsHtml = `
<sl-button-group name="extractionActions" label="Extraction" >
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

/**
 * Extraction options dialog
 * @typedef {object} extractionOptionsComponent
 * @property {SlSelect} modelIndex 
 * @property {SlSelect} instructionIndex
 * @property {SlInput} doi 
 */
const dialogHtml = `
<sl-dialog name="extractionOptions" label="Extract references">
  <div class="dialog-column">
    <sl-select name="modelIndex" label="Model" size="small" help-text="Choose the model configuration used for the extraction"></sl-select>
    <sl-select name="instructionIndex" label="Instructions" size="small" help-text="Choose the instruction set that is added to the prompt"></sl-select>  
    <sl-input name="doi" label="DOI" size="small" help-text="Please enter the DOI of the document to add document metadata"></input>   
  </div>
  <sl-button slot="footer" name="cancel" variant="neutral">Cancel</sl-button>
  <sl-button slot="footer" name="submit" variant="primary">Extract</sl-button>  
</sl-dialog>
`

//
// Implementation
//

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state
 */
function install(state) {

  // install controls on menubar
  appendHtml(buttonsHtml, ui.toolbar.self)

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
    if (state.pdfPath) {
      let { xml } = await extractFromPDF(state, { doi })
      await services.showMergeView(state, xml)
    }
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
    const { xml, pdf } = await extractFromPDF(state, { doi })
    await services.load(state, { xml, pdf })

  } catch (error) {
    dialog.error(error.message)
    console.error(error);
  }
}

/**
 * Extracts references from the given PDF file, letting the user choose the extraction options
 * @param {ApplicationState} state
 * @param {{doi:string}?} defaultOptions Optional default option object passed to the extraction service,
 * user will be prompted to choose own ones.
 * @returns {Promise<{xml:string, pdf:string}>} An object with path to the xml and pdf files
 * @throws {Error} If the DOI is not valid or the user aborts the dialog
 */
async function extractFromPDF(state, defaultOptions) {
  if(!state.pdfPath) throw new Error("Missing PDF path")

  // get DOI and instructions from user
  const options = await promptForExtractionOptions(defaultOptions)
  if (options === null) throw new Error("User abort")

  ui.spinner.show('Extracting references, please wait')
  try {
    let result = await client.extractReferences(state.pdfPath, options)
    await fileselection.reload(state)  // todo uncouple
    return result
  } finally {
    ui.spinner.hide()
  }
}

// utilities

/**
 * 
 * @param {{doi:string}?} options Optional default option object
 * @returns 
 */
async function promptForExtractionOptions(options) {

  // load instructions
  const instructionsData = await client.loadInstructions()
  const instructions = [];

  // add dialog to DOM
  const optionsDialog = appendHtml(dialogHtml)[0]

  // populate dialog
  /** @type {SlInput|null} */
  const doiInput = optionsDialog.querySelector('[name="doi"]')
  if (!doiInput) throw new Error("Missing DOM element")
  if (options && typeof options =="object" && 'doi' in options) {
    doiInput.value = options.doi
  }
  
  // configure selectbox 
  /** @type {SlSelect|null} */
  const selectbox = optionsDialog.querySelector('[name="instructionIndex"]')
  if (!selectbox) throw new Error("Missing DOM element")
  for (const [idx, { label, text }] of instructionsData.entries()) {
    const option = Object.assign(new SlOption, {
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
      optionsDialog.remove()
      resolve(null)
    }
    // user submits their input
    function submit() {
      optionsDialog.remove()
      resolve({
        // @ts-ignore
        'doi': optionsDialog.querySelector('[name="doi"]').value,
        // @ts-ignore
        'instructionIndex': parseInt(optionsDialog.querySelector('[name="instructionIndex"]').value)
      })
    }

    // event listeners
    optionsDialog.addEventListener("sl-request-close", cancel, { once: true })
    // @ts-ignore
    optionsDialog.querySelector('[name="cancel"]').addEventListener("click", cancel, { once: true })
    // @ts-ignore
    optionsDialog.querySelector('[name="submit"]').addEventListener("click", submit, { once: true })

    // @ts-ignore
    optionsDialog.show()
  })

  if (formData === null) {
    // user has cancelled the form
    return null
  }

  if (formData.doi == "" || !isDoi(formData.doi)) {
    dialog.error(`${formData.doi} does not seem to be a DOI, please try again.`)
    return
  }

  return Object.assign({
    doi: formData.doi,
    instructions: instructions[formData.instructionIndex]
  }, options)
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