/**
 * This implements the UI and the services for extracting references from the current or a new PDF
 */

/** 
 * @import { ApplicationState } from '../state.js' 
 * @import { SlButton } from '../ui.js'
 */
import { app, client, services, dialog, fileselection, xmlEditor, testLog } from '../app.js'
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

/**
 * Extraction dialog navigation properties
 * @typedef {object} extractionDialogPart
 * @property {SlInput} doi - DOI input field
 * @property {SlSelect} collectionName - Collection selection dropdown
 * @property {SlSelect} modelIndex - Model/extractor selection dropdown
 * @property {HTMLDivElement} dynamicOptions - Container for dynamic extractor options
 * @property {SlButton} cancel - Cancel button
 * @property {SlButton} submit - Submit button
 */

/**
 * Extractor configuration object
 * @typedef {object} ExtractorInfo
 * @property {string} id - Unique identifier for the extractor
 * @property {string} name - Display name for the extractor
 * @property {string[]} input - Supported input types (e.g., ['pdf'])
 * @property {string[]} output - Supported output types (e.g., ['tei-document'])
 * @property {Record<string, ExtractorOption>} [options] - Configuration options for the extractor
 */

/**
 * Extractor option configuration
 * @typedef {object} ExtractorOption
 * @property {string} type - Option type ('string', 'boolean', etc.)
 * @property {string} [label] - Display label for the option
 * @property {string} [description] - Help text for the option
 * @property {string[]} [options] - Predefined values for select options
 */

/**
 * Instruction data object
 * @typedef {object} InstructionData
 * @property {string} label - Display label for the instruction
 * @property {string[]} text - Array of instruction text lines
 * @property {string[]} [extractor] - Array of extractor IDs this instruction supports
 */

/**
 * Extraction result object
 * @typedef {object} ExtractionResult
 * @property {string} xml - Hash or content of the extracted XML
 * @property {string} [pdf] - Hash or path of the source PDF
 */

/**
 * Document metadata extracted from TEI XML
 * @typedef {object} DocumentMetadata
 * @property {string} [doi] - Document DOI
 * @property {string|null} [variant_id] - Extractor variant ID
 * @property {string} [extractor_flavor] - Extractor flavor/configuration
 * @property {string} [author] - Document author
 * @property {string} [title] - Document title
 * @property {string} [date] - Publication date
 * @property {string} [fileref] - File reference
 * @property {string} [last_update] - Last update timestamp
 */

/**
 * Form data collected from the extraction dialog
 * @typedef {object} ExtractionFormData
 * @property {string|null} doi - DOI value from form
 * @property {string} collection - Selected collection
 * @property {string} extractor - Selected extractor ID
 * @property {string} [variant_id] - Selected variant ID
 * @property {string} [instructions] - Instructions text
 * @property {string} [flavor] - Extractor flavor
 */

/**
 * Form data with dynamic options (intersection type)
 * @typedef {ExtractionFormData & Record<string, string|null>} DynamicExtractionFormData
 */
// Register templates
await registerTemplate('extraction-buttons', 'extraction-buttons.html');
await registerTemplate('extraction-dialog', 'extraction-dialog.html');

/**
 * @typedef {Object} ExtractionOptions
 * @property {string|null} [doi]
 * @property {string} [filename]
 * @property {string|null} [collection]
 * @property {string|null} [variant_id]
 * @property {string} [extractor]
 * @property {string} [instructions]
 * @property {Record<string, any>} [dynamicOptions] - Additional extractor-specific options
 */

//
// Implementation
//

async function install() {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // Create UI elements
  const extractionBtnGroup = createSingleFromTemplate('extraction-buttons');
  createSingleFromTemplate('extraction-dialog', document.body);

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
  
  ui.toolbar.extractionActions.childNodes.forEach(child => {
    if (child instanceof HTMLElement && 'disabled' in child) {
      /** @type {HTMLButtonElement} */(child).disabled = state.offline
    }
  }) 
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
 * Extracts references from the given source file (PDF or XML), letting the user choose the extraction options
 * @param {ApplicationState} state
 * @param {ExtractionOptions} [defaultOptions] Optional default option object passed to the extraction service,
 * user will be prompted to choose own ones.
 * @throws {UserAbortException} If the user cancels the form
 * @throws {Error} For all other errors
 */
async function extractFromPDF(state, defaultOptions={}) {
  try {
    // Check if we have either a PDF or XML content available
    if(!state.pdf && !defaultOptions.filename && !state.xml) {
      throw new Error("Missing source file: no PDF path or XML content available");
    }

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
      if (!options) throw new Error("Missing extraction options")

      // Determine which source file to use based on extractor type
      const extractors = await client.getExtractorList()
      const selectedExtractor = extractors.find(e => e.id === options.extractor)
      const needsXmlContent = selectedExtractor && selectedExtractor.input.includes("xml")

      let file_id;
      if (needsXmlContent && state.xml) {
        // For XML-based extractors, use the XML hash
        file_id = state.xml;
      } else {
        // For PDF-based extractors, use PDF hash or filename
        file_id = options.filename || state.pdf;
      }

      if (!file_id) {
        throw new Error("No source file available for extraction");
      }

      // Use the simplified extract API
      result = await client.extract(file_id, options);

      // Force reload of file list since server has updated cache
      await fileselection.reload({refresh:true})

      // Update state.variant with the variant_id that was used for extraction
      if (options && options.variant_id) {
        await app.updateState({ variant: options.variant_id })
      }

      // Load the extracted result (server now returns hashes)
      // For XML-only results (like schema), clear PDF state first
      /** @type {ExtractionResult} */
      const typedResult = /** @type {ExtractionResult} */(result)
      if (typedResult && typedResult.pdf === null) {
        await app.updateState({ pdf: null })
      }
      await services.load(result)

      testLog('EXTRACTION_COMPLETED', { resultHash: typedResult.xml, sourceFileId: file_id });

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
  /** @type {string[]} */
  const instructions = [];

  // Get document metadata to pre-fill form with current document values
  /** @type {DocumentMetadata} */
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
    // Show extractors based on available content
    availableExtractors = extractors.filter(extractor => {
      // Show PDF extractors if we have a PDF
      const supportsPdf = extractor.input.includes("pdf") && (currentState?.pdf || options.filename)
      // Show XML extractors if we have XML content
      const supportsXml = extractor.input.includes("xml") && currentState?.xml

      return supportsPdf || supportsXml
    })
    
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
    logger.warn("Could not load extraction engines: " + String(error))
    // Disable extraction functionality when extractors can't be loaded
    modelSelectBox.disabled = true
    availableExtractors = []
  }
  
  // Add event listener to update dynamic options when model changes
  const updateDynamicOptions = () => {
    const selectedExtractorId = String(modelSelectBox.value)
    if (!selectedExtractorId) return

    const selectedExtractor = availableExtractors.find(e => e.id === selectedExtractorId)

    // Hide DOI field for XML-based extractors (like RNG schema extractor)
    const isXmlExtractor = selectedExtractor && selectedExtractor.input.includes("xml")
    if (isXmlExtractor) {
      /** @type {any} */(ui.extractionOptions.doi).style.display = 'none';
      const doiContainer = ui.extractionOptions.doi.closest('sl-input, .form-group, .field');
      if (doiContainer) {
        /** @type {HTMLElement} */(doiContainer).style.display = 'none';
      }
    } else {
      /** @type {any} */(ui.extractionOptions.doi).style.display = '';
      const doiContainer = ui.extractionOptions.doi.closest('sl-input, .form-group, .field');
      if (doiContainer) {
        /** @type {HTMLElement} */(doiContainer).style.display = '';
      }
    }

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
  /**
   * @param {string} optionKey
   * @param {ExtractorOption} optionConfig
   * @param {string} extractorId
   * @returns {SlSelect|SlInput|null}
   */
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
        /** @type {InstructionData} */
        const instructionDataTyped = /** @type {InstructionData} */(instructionData)
        const { label, text, extractor = [] } = instructionDataTyped
        
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
  /** @type {DynamicExtractionFormData} */
  const formData = {
    'doi': ui.extractionOptions.doi.value || null,
    'collection': String(ui.extractionOptions.collectionName.value),
    'extractor': String(ui.extractionOptions.modelIndex.value)
  }
  
  // Collect values from dynamic options
  const dynamicOptionsContainer = ui.extractionOptions.querySelector('[name="dynamicOptions"]')
  /** @type {NodeListOf<SlSelect|SlInput>} */
  const dynamicInputs = /** @type {NodeListOf<SlSelect|SlInput>} */(dynamicOptionsContainer?.querySelectorAll('sl-select, sl-input') || [])

  for (const input of dynamicInputs) {
    /** @type {SlSelect|SlInput} */
    const typedInput = /** @type {SlSelect|SlInput} */(input)
    const name = typedInput.name
    let value = typedInput.value
    
    // Special handling for instructions - convert to actual instruction text
    if (name === 'instructions' && instructions[parseInt(String(value))]) {
      value = instructions[parseInt(String(value))]
    }

    formData[name] = String(value)
  }
  
  // Check if selected extractor is XML-based (doesn't need DOI)
  const selectedExtractor = availableExtractors.find(e => e.id === formData.extractor)
  const isXmlExtractor = selectedExtractor && selectedExtractor.input.includes("xml")

  // Validate DOI only if one is provided and we're not using an XML extractor
  if (!isXmlExtractor && formData.doi && formData.doi !== "" && !isDoi(formData.doi)) {
    dialog.error(`"${formData.doi}" does not seem to be a DOI, please try again.`)
    return null
  }

  // If DOI is empty or using XML extractor, set it to null for the request
  if (!formData.doi || formData.doi === "" || isXmlExtractor) {
    formData.doi = null
  }

  return Object.assign(options, formData)
}



/**
 * Extract DOI from filename
 * @param {string} filename
 * @returns {string|null}
 */
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