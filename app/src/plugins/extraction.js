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
import { isDoi, extractDoi } from '../modules/utils.js';
import { UserAbortException } from '../modules/utils.js'
import { getDocumentMetadata } from '../modules/tei-utils.js'

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

  // Add extraction buttons to toolbar with medium priority
  ui.toolbar.add(extractionBtnGroup, 7);
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
  await extractFromPDF(state)
}

/**
 * Upload a new PDF and extract from it
 * @param {ApplicationState} state
 */
async function extractFromNewPdf(state) {
  const { type, filename, originalFilename } = await client.uploadFile();
  if (type !== "pdf") {
    dialog.error("Extraction is only possible from PDF files")
    return
  }

  const doi = getDoiFromFilename(originalFilename)
  await extractFromPDF(state, { doi, filename })
}

/**
 * Extracts references from the given PDF file, letting the user choose the extraction options
 * @param {ApplicationState} state
 * @param {ExtractionOptions} [defaultOptions] Optional default option object passed to the extraction service,
 * user will be prompted to choose own ones.
 * @throws {UserAbortException} If the user cancels the form
 * @throws {Error} For all other errors
 */
async function extractFromPDF(state, defaultOptions={}) {
  try {
    // Check if we have either a PDF in state or a filename in options
    if(!state.pdf && !defaultOptions.filename) throw new Error("Missing PDF path")

    // Extract DOI from document metadata or filename if not provided
    let doi = defaultOptions.doi;
    if (!doi) {
      try {
        const xmlDoc = xmlEditor.getXmlTree();
        if (xmlDoc) {
          const metadata = getDocumentMetadata(xmlDoc);
          doi = metadata.doi;
        }
      } catch (error) {
        console.warn("Cannot get DOI from document:", error.message)
      }
      
      // Fallback to extracting DOI from filename (use state.pdf or uploaded filename)
      const filenameForDoi = state.pdf || defaultOptions.filename
      if (filenameForDoi) {
        doi = doi || getDoiFromFilename(filenameForDoi)
      }
    }
    
    // Add collection, DOI, and variant to options
    const enhancedOptions = {
      collection: state.collection,
      variant_id: state.variant,
      doi,
      ...defaultOptions
    }

    // get DOI and instructions from user
    const options = await promptForExtractionOptions(enhancedOptions)

    ui.spinner.show('Extracting references, please wait')
    let result
    try {
      const filename = options.filename || state.pdf
      result = await client.extractReferences(filename, options)
      
      // Force reload of file list since server has updated cache
      await fileselection.reload(state, {refresh:true})
      
      // Load the extracted result (server now returns hashes)
      await services.load(state, result)
      
    } finally {
      ui.spinner.hide()
    }
    
  } catch (error) {
    console.error(error.message);
    if (error instanceof UserAbortException) {
      return // do nothing
    }
    dialog.error(error.message)
  }
}

/**
 * 
 * @param {ExtractionOptions} options Optional default option object
 * @returns {Promise<ExtractionOptions|null>}
 */
async function promptForExtractionOptions(options={}) {

  // load instructions
  const instructionsData = await client.loadInstructions()
  const instructions = [];

  // Get document metadata to pre-fill form with current document values
  let documentMetadata = {};
  try {
    const xmlDoc = xmlEditor.getXmlTree();
    if (xmlDoc) {
      documentMetadata = getDocumentMetadata(xmlDoc);
    }
  } catch (error) {
    console.warn("Could not extract document metadata:", error.message);
  }

  // use doi if available - prioritize options parameter, then document metadata
  const doiValue = options.doi || documentMetadata.doi || "";
  optionsDialog.doi.value = doiValue;

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
  // Set collection value - prioritize options parameter, then first available collection
  const collectionValue = options.collection || (collections.length > 0 ? collections[0] : "");
  collectionSelectBox.value = collectionValue
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
    
    // Default to extractor that supports the document's variant, or first available extractor
    if (availableExtractors.length > 0) {
      let defaultExtractor = availableExtractors[0].id;
      
      // If we have a variant_id from the document or options, find the extractor that supports it
      const variantId = documentMetadata.variant_id || options.variant_id;
      if (variantId) {
        const extractorForVariant = availableExtractors.find(extractor => {
          const variantOptions = extractor.options?.variant_id?.options;
          return Array.isArray(variantOptions) && variantOptions.includes(variantId);
        });
        
        if (extractorForVariant) {
          defaultExtractor = extractorForVariant.id;
        }
      }
      
      modelSelectBox.value = defaultExtractor;
    }
  } catch (error) {
    // No fallback - if we can't load extractors, we can't extract
    throw new Error("Could not load extraction engines:" + error.message)
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
      
      // Set default value - use document metadata or options if available for variant_id
      const variantId = documentMetadata.variant_id || options.variant_id;
      if (optionKey === 'variant_id' && variantId && 
          optionConfig.options.includes(variantId)) {
        select.value = variantId;
      } else if (optionKey === 'flavor' && documentMetadata.extractor_flavor && 
                 optionConfig.options.includes(documentMetadata.extractor_flavor)) {
        select.value = documentMetadata.extractor_flavor;
      } else if (optionConfig.options.length > 0) {
        select.value = optionConfig.options[0];
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
      for (const instructionData of instructionsData) {
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
    throw new UserAbortException("User cancelled the dialog")
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

  return Object.assign(options, formData)
}



function getDoiFromFilename(filename) {
  console.debug("Extracting DOI from filename:", filename);
  if (!filename) return null;

  // 1. Sanitize: remove extension, decode URI components
  let candidate = filename.toLowerCase().split('.pdf')[0];
  candidate = decodeURIComponent(candidate);
  
  // 2. Normalize: handle different separator conventions
  candidate = candidate.replaceAll(/__/g, '/');
  candidate = candidate.replace(/10\.(\d+)_(.+)/, '10.$1/$2');
  
  // 3. Extract from the normalized string
  const doi = extractDoi(candidate);
  console.debug("Extracted DOI from filename:", doi);
  
  return doi;
}