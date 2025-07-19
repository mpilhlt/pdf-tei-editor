/**
 * This implements the UI and the services for extracting references from the current or a new PDF
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlButton, SlButtonGroup, SlInput } from '../ui.js'
 */
import { client, services, dialog, fileselection, xmlEditor, updateState } from '../app.js'
import { SlSelect, SlOption, createHtmlElements, updateUi } from '../ui.js'
import ui from '../ui.js'
import { logger } from '../app.js'

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
/** @type {extractionActionsComponent} */
const extractionBtnGroup = await createHtmlElements('extraction-buttons.html')


/**
 * Extraction options dialog
 * @typedef {object} extractionOptionsDialog
 * @property {SlInput} doi 
 * @property {SlSelect} collectionName
 * @property {SlSelect} modelIndex 
 * @property {SlSelect} instructionIndex
 */
/** @type {extractionOptionsDialog} */
const optionsDialog = (await createHtmlElements('extraction-dialog.html'))[0]

//
// Implementation
//

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // install controls on menubar
  console.warn(ui.toolbar.self.childElementCount)
  ui.toolbar.self.append(...extractionBtnGroup)
  document.body.append(optionsDialog)
  updateUi()

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
    const { type, filename, originalFilename } = await client.uploadFile();
    if (type !== "pdf") {
      dialog.error("Extraction is only possible from PDF files")
      return
    }

    const doi = getDoiFromFilename(originalFilename)
    const { xml, pdf } = await extractFromPDF(state, { doi, filename })
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
  let result
  try {
    const filename = options.filename || state.pdfPath
    result = await client.extractReferences(filename, options)
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

  // populate dialog
  /** @type {SlInput|null} */
  if (options && typeof options =="object" && 'doi' in options) {
    optionsDialog.doi.value = options.doi
  } else {
    optionsDialog.doi.value = ""
  }

  // configure collections selectbox 
  /** @type {SlSelect|null} */
  const collectionSelectBox = optionsDialog.collectionName
  collectionSelectBox.innerHTML=""
  const collections = JSON.parse(ui.toolbar.pdf.dataset.collections)
  collections.unshift('__inbox')
  for (const collection_name of collections){
    const option = Object.assign(new SlOption, {
      value: collection_name,
      textContent: collection_name.replaceAll("_", " ").trim()
    })
    collectionSelectBox.append(option)
  } 
  collectionSelectBox.value = "__inbox"
  
  // configure instructions selectbox 
  /** @type {SlSelect|null} */
  const instructionsSelectBox = optionsDialog.instructionIndex
  instructionsSelectBox.innerHTML =""
  for (const [idx, { label, text }] of instructionsData.entries()) {
    const option = Object.assign(new SlOption, {
      value: String(idx),
      textContent: label
    })
    instructions[idx] = text.join("\n")
    instructionsSelectBox.appendChild(option)
  }
  instructionsSelectBox.value = "0"

  // display the dialog and await the user's response
  const result = await new Promise(resolve => {
    // user cancels
    function cancel() {
      resolve(false)
    }
    // user submits their input
    function submit() {
      resolve(true)
    }

    // event listeners
    optionsDialog.addEventListener("sl-request-close", cancel, { once: true })
    optionsDialog.cancel.addEventListener("click", cancel, { once: true })
    optionsDialog.submit.addEventListener("click", submit, { once: true })

    optionsDialog.show()
  })
  optionsDialog.hide()

  if (result === false) {
    // user has cancelled the form
    return null
  }

  const formData = {
    'doi': optionsDialog.doi.value,
    'instructions': instructions[parseInt(optionsDialog.instructionIndex.value)],
    'collection': optionsDialog.collectionName.value
  }

  console.warn(formData)

  if (formData.doi == "" || !isDoi(formData.doi)) {
    dialog.error(`"${formData.doi}" does not seem to be a DOI, please try again.`)
    return
  }

  return Object.assign(formData, options)
}

function getDoiFromXml() {
  return xmlEditor.getDomNodeByXpath("//tei:teiHeader//tei:idno[@type='DOI']")?.textContent
}

function getDoiFromFilename(filename) {
  let doi = null
  console.debug("Extracting DOI from filename:", filename)
  if (filename.match(/^10\./)) {
    // treat as a DOI-like filename
    // do we have URL-encoded filenames?
    doi = filename.slice(0, -4)
    if (decodeURIComponent(doi) !== doi) {
      // filename is URL-encoded DOI
      doi = decodeURIComponent(doi)
    } else {
      // custom decoding
      doi = doi.replace(/10\.(\d+)_(.+)/g, '10.$1/$2')
      doi = doi.replaceAll(/__/g, '/')
    }
    console.debug("Extracted DOI from filename:", doi)
    if (isDoi(doi)) {
      return doi
    }
  }
  return null
}


function isDoi(doi) {
  // from https://www.crossref.org/blog/dois-and-matching-regular-expressions/
  const DOI_REGEX = /^10.\d{4,9}\/[-._;()\/:A-Z0-9]+$/i
  return Boolean(doi.match(DOI_REGEX))
}