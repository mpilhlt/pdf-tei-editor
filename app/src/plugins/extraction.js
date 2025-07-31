/**
 * This implements the UI and the services for extracting references from the current or a new PDF
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlButton, SlButtonGroup, SlDialog, SlInput } from '../ui.js'
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
  install,
  state: {update}
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
/** @type {SlButtonGroup & extractionActionsComponent} */
// @ts-ignore
const extractionBtnGroup = (await createHtmlElements('extraction-buttons.html'))[0]


/**
 * Extraction options dialog
 * @typedef {object} extractionOptionsDialog
 * @property {SlDialog} self
 * @property {SlInput} doi 
 * @property {SlSelect} collectionName
 * @property {SlSelect} modelIndex 
 * @property {SlSelect} instructionIndex
 */
/** @type {extractionOptionsDialog & SlDialog} */
// @ts-ignore
const optionsDialog = (await createHtmlElements('extraction-dialog.html'))[0]

/**
 * @typedef {Object} ExtractionOptions
 * @property {string} [doi] 
 * @property {string} [filename]
 * @property {string} [collection]
 */

//
// Implementation
//

/**
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // install controls on menubar
  ui.toolbar.self.append(extractionBtnGroup)
  document.body.append(optionsDialog)
  updateUi()

  // add event listeners
  ui.toolbar.extractionActions.extractNew.addEventListener('click', () => extractFromNewPdf(state))
  ui.toolbar.extractionActions.extractCurrent.addEventListener('click', () => extractFromCurrentPDF(state))
}

/**
 * @param {ApplicationState} state
 */
async function update(state) {
  // @ts-ignore
  extractionBtnGroup.self.childNodes.forEach(child => child.disabled = state.offline) 
  extractionBtnGroup.extractCurrent.disabled = !state.pdfPath
  //console.warn(plugin.name,"done")
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
      const collection = state.pdfPath.split("/").at(-2)
      let { xml } = await extractFromPDF(state, { doi, collection })
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
 * @param {ExtractionOptions} [defaultOptions] Optional default option object passed to the extraction service,
 * user will be prompted to choose own ones.
 * @returns {Promise<{xml:string, pdf:string}>} An object with path to the xml and pdf files
 * @throws {Error} If the DOI is not valid or the user aborts the dialog
 */
async function extractFromPDF(state, defaultOptions={}) {
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
 * @param {ExtractionOptions} options Optional default option object
 * @returns {Promise<ExtractionOptions>}
 */
async function promptForExtractionOptions(options={}) {

  // load instructions
  const instructionsData = await client.loadInstructions()
  const instructions = [];

  // use doi if available
  if ('doi' in options && options.doi) {
    optionsDialog.doi.value = options.doi
  } else {
    optionsDialog.doi.value = ""
  }

  // configure collections selectbox 
  /** @type {SlSelect|null} */
  const collectionSelectBox = optionsDialog.collectionName
  collectionSelectBox.innerHTML=""
  const collectionData = ui.toolbar.pdf.dataset.collections || '[]'
  const collections = JSON.parse(collectionData)
  collections.unshift('__inbox')
  for (const collection_name of collections){
    const option = Object.assign(new SlOption, {
      value: collection_name,
      textContent: collection_name.replaceAll("_", " ").trim()
    })
    collectionSelectBox.append(option)
  } 
  collectionSelectBox.value = options.collection || "__inbox"
  // if we have a collection, it cannot be changed
  collectionSelectBox.disabled = Boolean(options.collection)

  // configure model selectbox with available extractors
  /** @type {SlSelect|null} */
  const modelSelectBox = optionsDialog.modelIndex
  modelSelectBox.innerHTML = ""
  try {
    const extractors = await client.getExtractorList()
    // Filter extractors that support PDF input and TEI document output
    const pdfToTeiExtractors = extractors.filter(extractor => 
      extractor.input.includes("pdf") && extractor.output.includes("tei-document")
    )
    
    for (const extractor of pdfToTeiExtractors) {
      const option = Object.assign(new SlOption, {
        value: extractor.id,
        textContent: extractor.name
      })
      modelSelectBox.appendChild(option)
    }
    
    // Default to llamore-gemini if available
    if (pdfToTeiExtractors.find(e => e.id === "llamore-gemini")) {
      modelSelectBox.value = "llamore-gemini"
    } else if (pdfToTeiExtractors.length > 0) {
      modelSelectBox.value = pdfToTeiExtractors[0].id
    }
  } catch (error) {
    logger.warn("Could not load extractor list:", error)
    // Fallback to hardcoded option
    const option = Object.assign(new SlOption, {
      value: "llamore-gemini",
      textContent: "LLamore + Gemini"
    })
    modelSelectBox.appendChild(option)
    modelSelectBox.value = "llamore-gemini"
  }
  
  // Add event listener to update instructions when model changes
  const updateInstructions = () => {
    const selectedExtractor = modelSelectBox.value || "llamore-gemini"
    instructionsSelectBox.innerHTML = ""
    
    let instructionIndex = 0
    for (const [originalIdx, instructionData] of instructionsData.entries()) {
      const { label, text, extractor = ["llamore-gemini"] } = instructionData
      
      // Check if this instruction supports the selected extractor
      if (extractor.includes(selectedExtractor)) {
        const option = Object.assign(new SlOption, {
          value: String(instructionIndex),
          textContent: label
        })
        instructions[instructionIndex] = text.join("\n")
        instructionsSelectBox.appendChild(option)
        instructionIndex++
      }
    }
    
    // If no instructions found for this extractor, show a default option
    if (instructionIndex === 0) {
      const option = Object.assign(new SlOption, {
        value: "0",
        textContent: "No custom instructions"
      })
      instructions[0] = ""
      instructionsSelectBox.appendChild(option)
    }
    
    instructionsSelectBox.value = "0"
  }
  
  modelSelectBox.addEventListener('sl-change', updateInstructions)
  
  // configure instructions selectbox - filter by selected extractor
  /** @type {SlSelect|null} */
  const instructionsSelectBox = optionsDialog.instructionIndex
  
  // Initial population of instructions
  updateInstructions()

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
    'instructions': instructions[parseInt(String(optionsDialog.instructionIndex.value))],
    'collection': optionsDialog.collectionName.value,
    'extractor': optionsDialog.modelIndex.value
  }
  
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
      doi = doi.replaceAll(/__/g, '/')
      doi = doi.replace(/10\.(\d+)_(.+)/g, '10.$1/$2')
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