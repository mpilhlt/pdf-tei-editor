/**
 * This implements the UI and the services for extracting references from the current or a new PDF
 */

/** 
 * @import { ApplicationState } from '../state.js' 
 * @import { SlButton, SlButtonGroup, SlDialog } from '../ui.js'
 */
import { app, client, services, dialog, fileselection, xmlEditor, updateState, testLog } from '../app.js'
import { SlSelect, SlOption, SlInput, updateUi } from '../ui.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
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

// Current state for use in event handlers
/** @type {ApplicationState} */
let currentState;

//
// UI
//

/**
 * Extraction actions button group
 * @typedef {object} extractionActionsPart
 * @property {SlButton} extractNew 
 * @property {SlButton} extractCurrent
 * @property {SlButton} editInstructions - added by prompt-editor plugin
 */
// Register templates
await registerTemplate('extraction-buttons', 'extraction-buttons.html');
await registerTemplate('extraction-dialog', 'extraction-dialog.html');

/**
 * @typedef {Object} ExtractionOptions
 * @property {string|null} [doi] 
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

  // Create UI elements
  const extractionBtnGroup = createSingleFromTemplate('extraction-buttons');
  const optionsDialog = createSingleFromTemplate('extraction-dialog', document.body);

  // Add extraction buttons to toolbar with medium priority
  ui.toolbar.add(extractionBtnGroup, 7);
  updateUi()

  // add event listeners
  ui.toolbar.extractionActions.extractNew.addEventListener('click', () => {
    if (currentState) extractFromNewPdf(currentState);
  })
  ui.toolbar.extractionActions.extractCurrent.addEventListener('click', () => {
    if (currentState) extractFromCurrentPDF(currentState);
  })
}

/**
 * @param {ApplicationState} state
 */
async function update(state) {
  // Store current state for use in event handlers
  currentState = state;
  
  // @ts-ignore
  ui.toolbar.extractionActions.childNodes.forEach(child => child.disabled = state.offline) 
  ui.toolbar.extractionActions.extractCurrent.disabled = !state.pdf
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
  try {
    const { type, filename, originalFilename } = await client.uploadFile();

    if (type !== "pdf") {
      dialog.error("Extraction is only possible from PDF files")
      return
    }

    testLog('PDF_UPLOAD_COMPLETED', { originalFilename, filename, type });

    const doi = getDoiFromFilename(originalFilename)

    await extractFromPDF(state, { doi, filename })
  } catch (error) {
    throw error;
  }
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
        console.warn("Cannot get DOI from document:", String(error))
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
    testLog('EXTRACTION_OPTIONS_DIALOG_STARTING', { enhancedOptions });
    const options = await promptForExtractionOptions(enhancedOptions)

    ui.spinner.show('Extracting, please wait')
    let result
    try {
      const filename = options.filename || state.pdf
      result = await client.extractReferences(filename, options)

      // Force reload of file list since server has updated cache
      await fileselection.reload({refresh:true})

      // Update state.variant with the variant_id that was used for extraction
      if (options.variant_id) {
        await app.updateState({ variant: options.variant_id })
      }

      // Load the extracted result (server now returns hashes)
      await services.load(result)

      testLog('EXTRACTION_COMPLETED', { resultHash: result.xml, pdfFilename: filename });

    } finally {
      ui.spinner.hide()
    }

  } catch (error) {
    console.error(String(error));
    if (error instanceof UserAbortException) {
      return // do nothing
    }
    dialog.error(String(error))
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
    console.warn("Could not extract document metadata:", String(error));
  }

  // use doi if available - prioritize options parameter, then document metadata
  const doiValue = options.doi || documentMetadata.doi || "";
  ui.extractionOptions.doi.value = doiValue;

  // configure collections selectbox 
  /** @type {SlSelect|null} */
  const collectionSelectBox = ui.extractionOptions.collectionName
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
  const modelSelectBox = ui.extractionOptions.modelIndex
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
    // Handle extractor list loading gracefully
    logger.warn("Could not load extraction engines:", String(error))
    // Disable extraction functionality when extractors can't be loaded
    modelSelectBox.disabled = true
    availableExtractors = []
  }
  
  // Add event listener to update dynamic options when model changes
  const updateDynamicOptions = () => {
    const selectedExtractorId = modelSelectBox.value
    if (!selectedExtractorId) return
    
    const selectedExtractor = availableExtractors.find(e => e.id === selectedExtractorId)
    
    // Clear existing dynamic options
    const dynamicOptionsContainer = ui.extractionOptions.querySelector('[name="dynamicOptions"]')
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
        label: optionConfig.label || optionKey,
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
        label: optionConfig.label || optionKey,
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
    ui.extractionOptions.addEventListener("sl-request-close", cancel, { once: true })
    ui.extractionOptions.cancel.addEventListener("click", cancel, { once: true })
    ui.extractionOptions.submit.addEventListener("click", submit, { once: true })

    ui.extractionOptions.show()
  })
  ui.extractionOptions.hide()

  if (result === false) {
    // user has cancelled the form
    throw new UserAbortException("User cancelled the dialog")
  }

  // Collect form data from static and dynamic fields
  const formData = {
    'doi': ui.extractionOptions.doi.value,
    'collection': ui.extractionOptions.collectionName.value,
    'extractor': ui.extractionOptions.modelIndex.value
  }
  
  // Collect values from dynamic options
  const dynamicOptionsContainer = ui.extractionOptions.querySelector('[name="dynamicOptions"]')
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