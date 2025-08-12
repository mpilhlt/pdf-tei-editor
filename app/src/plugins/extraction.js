/**
 * This implements the UI and the services for extracting references from the current or a new PDF
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlButton, SlButtonGroup, SlDialog } from '../ui.js'
 */
import { client, services, dialog, fileselection, xmlEditor, updateState } from '../app.js'
import { SlSelect, SlOption, SlInput, createHtmlElements, updateUi } from '../ui.js'
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
 * @typedef {object} extractionActionsPart
 * @property {SlButtonGroup} self
 * @property {SlButton} extractNew 
 * @property {SlButton} extractCurrent
 * @property {SlButton} editInstructions - added by prompt-editor plugin
 */
/** @type {SlButtonGroup & extractionActionsPart} */
// @ts-ignore
const extractionBtnGroup = (await createHtmlElements('extraction-buttons.html'))[0]


/**
 * Extraction options dialog
 * @typedef {object} extractionOptionsDialog
 * @property {SlDialog} self
 * @property {SlInput} doi 
 * @property {SlSelect} collectionName
 * @property {SlSelect} modelIndex 
 * @property {SlButton} cancel
 * @property {SlButton} submit
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
  ui.toolbar.append(extractionBtnGroup)
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
  extractionBtnGroup.childNodes.forEach(child => child.disabled = state.offline) 
  extractionBtnGroup.extractCurrent.disabled = !state.pdf
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
    doi = doi || getDoiFromFilename(state.pdf)
    if (state.pdf) {
      const collection = state.pdf.split("/").at(-2)
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
  if(!state.pdf) throw new Error("Missing PDF path")

  // get DOI and instructions from user
  const options = await promptForExtractionOptions(defaultOptions)
  if (options === null) throw new Error("User abort")

  ui.spinner.show('Extracting references, please wait')
  let result
  try {
    const filename = options.filename || state.pdf
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
 * @returns {Promise<ExtractionOptions|null>}
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
  
  // Get extractors and store for dynamic options
  let availableExtractors = []
  try {
    const extractors = await client.getExtractorList()
    // Filter extractors that support PDF input and TEI document output
    availableExtractors = extractors.filter(extractor => 
      extractor.input.includes("pdf") && extractor.output.includes("tei-document")
    )
    
    for (const extractor of availableExtractors) {
      const option = Object.assign(new SlOption, {
        value: extractor.id,
        textContent: extractor.name
      })
      modelSelectBox.appendChild(option)
    }
    
    // Default to first available extractor
    if (availableExtractors.length > 0) {
      modelSelectBox.value = availableExtractors[0].id
    }
  } catch (error) {
    // No fallback - if we can't load extractors, we can't extract
    dialog.error("Could not load extraction engines")
    throw error
  }
  
  // Add event listener to update dynamic options when model changes
  const updateDynamicOptions = () => {
    const selectedExtractorId = modelSelectBox.value
    if (!selectedExtractorId) return
    
    const selectedExtractor = availableExtractors.find(e => e.id === selectedExtractorId)
    
    // Clear existing dynamic options
    const dynamicOptionsContainer = optionsDialog.querySelector('[name="dynamicOptions"]')
    if (dynamicOptionsContainer) {
      dynamicOptionsContainer.innerHTML = ""
    }
    if (!selectedExtractor || !selectedExtractor.options) return
    
    // Generate UI elements for each extractor option (except doi which is handled separately)
    for (const [optionKey, optionConfig] of Object.entries(selectedExtractor.options)) {
      if (optionKey === 'doi') continue // DOI is handled separately
      
      const element = createOptionElement(optionKey, optionConfig, selectedExtractorId)
      if (element && dynamicOptionsContainer) {
        dynamicOptionsContainer.appendChild(element)
      }
    }
  }
  
  // Helper function to create form elements for extractor options
  function createOptionElement(optionKey, optionConfig, extractorId) {
    if (optionConfig.type === 'string' && optionConfig.options) {
      // Create select dropdown for predefined options
      const select = Object.assign(new SlSelect, {
        name: optionKey,
        label: optionConfig.description || optionKey,
        size: "small"
      })
      
      if (optionConfig.description) {
        select.setAttribute("help-text", optionConfig.description)
      }
      
      // Add options
      for (const optionValue of optionConfig.options) {
        const option = Object.assign(new SlOption, {
          value: optionValue,
          textContent: optionValue
        })
        select.appendChild(option)
      }
      
      // Set default to first option
      if (optionConfig.options.length > 0) {
        select.value = optionConfig.options[0]
      }
      
      return select
    } else if (optionKey === 'instructions' && extractorId && instructionsData) {
      // Special handling for instructions - use existing instructions data
      const select = Object.assign(new SlSelect, {
        name: "instructions",
        label: "Instructions",
        size: "small"
      })
      select.setAttribute("help-text", "Choose the instruction set that is added to the prompt")
      
      let instructionIndex = 0
      for (const [originalIdx, instructionData] of instructionsData.entries()) {
        const { label, text, extractor = [] } = instructionData
        
        // Check if this instruction supports the selected extractor
        if (extractor.includes(extractorId)) {
          const option = Object.assign(new SlOption, {
            value: String(instructionIndex),
            textContent: label
          })
          instructions[instructionIndex] = text.join("\n")
          select.appendChild(option)
          instructionIndex++
        }
      }
      
      // If no instructions found, show a default option
      if (instructionIndex === 0) {
        const option = Object.assign(new SlOption, {
          value: "0",
          textContent: "No custom instructions"
        })
        instructions[0] = ""
        select.appendChild(option)
      }
      
      select.value = "0"
      return select
    } else if (optionConfig.type === 'string') {
      // Create text input for free-form string fields
      const input = Object.assign(new SlInput, {
        name: optionKey,
        label: optionConfig.description || optionKey,
        size: "small",
        type: "text"
      })
      
      if (optionConfig.description) {
        input.setAttribute("help-text", optionConfig.description)
      }
      
      return input
    }
    
    return null
  }
  
  modelSelectBox.addEventListener('sl-change', updateDynamicOptions)
  
  // Initial population of dynamic options
  updateDynamicOptions()

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

  // Collect form data from static and dynamic fields
  const formData = {
    'doi': optionsDialog.doi.value,
    'collection': optionsDialog.collectionName.value,
    'extractor': optionsDialog.modelIndex.value
  }
  
  // Collect values from dynamic options
  const dynamicOptionsContainer = optionsDialog.querySelector('[name="dynamicOptions"]')
  // @ts-ignore
  const dynamicInputs = dynamicOptionsContainer.querySelectorAll('sl-select, sl-input')
  
  for (const input of dynamicInputs) {
    const name = input.name
    let value = input.value
    
    // Special handling for instructions - convert to actual instruction text
    if (name === 'instructions' && instructions[parseInt(value)]) {
      value = instructions[parseInt(value)]
    }
    
    formData[name] = value
  }
  
  // Validate DOI only if one is provided
  if (formData.doi && formData.doi !== "" && !isDoi(formData.doi)) {
    dialog.error(`"${formData.doi}" does not seem to be a DOI, please try again.`)
    return null
  }
  
  // If DOI is empty, set it to null for the request
  if (!formData.doi || formData.doi === "") {
    formData.doi = null
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