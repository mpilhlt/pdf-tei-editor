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
import { extractDoi } from '../modules/doi-utils.js';
import { UserAbortException } from '../modules/utils.js'
import { getDocumentMetadata } from '../modules/tei-utils.js'
import { getFileDataById } from '../modules/file-data-utils.js'

// Current state for use in event handlers
/** @type {ApplicationState} */
let currentState;


/**
 * @typedef {object} ExtractorInfo
 * 
 */

// List of extractor information
/** @type {ExtractorInfo} */
let extractors;

/**
 * plugin API
 */
const api = {
  extractFromCurrentPDF,
  extractFromNewPdf,
  extractFromPDF,
  extractorInfo : () => extractors
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
 * @property {Array<{label: string, options: string[]}>} [groups] - Grouped values; renders as flat list with "[group] value" display text; values use "group/value" format
 * @property {Record<string, string>} [depends] - Only render this option when all key=value pairs match current dynamic option values
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

      // Fallback: extract DOI from uploaded filename (only meaningful for new uploads, not stable IDs)
      if (!doi && defaultOptions.filename) {
        doi = getDoiFromFilename(defaultOptions.filename)
      }

      // Fallback: try to extract DOI from the document's doc_id (e.g. "10.1234/some-doi")
      if (!doi) {
        const fileId = state.pdf || state.xml
        const docId = fileId ? getFileDataById(fileId)?.file?.doc_id : null
        if (docId) {
          doi = extractDoi(docId)
        }
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

  // Get collections from state (includes RBAC-filtered collections)
  const collections = currentState?.collections || [];

  // Add accessible collections from state
  for (const collection of collections){
    const option = Object.assign(new SlOption, {
      value: collection.id,
      textContent: collection.name
    })
    collectionSelectBox.append(option)
  }

  // Set collection value - prioritize options parameter, then first available collection
  const collectionValue = options.collection || (collections.length > 0 ? collections[0].id : "_inbox");
  collectionSelectBox.value = collectionValue

  // configure model selectbox with available extractors
  /** @type {SlSelect|null} */
  const modelSelectBox = ui.extractionOptions.modelIndex
  modelSelectBox.innerHTML = ""
  
  // Get extractors and store for dynamic options
  let availableExtractors = []
  try {
    // Lazy load extractors if not already loaded
    if (!extractors) {
      extractors = await client.getExtractorList()
    }

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

    // Hide DOI and collection fields for XML-based extractors
    const isXmlExtractor = selectedExtractor && selectedExtractor.input.includes("xml")
    const doiEl = /** @type {HTMLElement} */(ui.extractionOptions.doi)
    const collectionEl = /** @type {HTMLElement} */(collectionSelectBox.parentElement)
    doiEl.style.display = isXmlExtractor ? 'none' : ''
    if (collectionEl) collectionEl.style.display = isXmlExtractor ? 'none' : ''

    // Snapshot current dynamic option values before clearing.
    // Use .name property (not getAttribute) since Shoelace reflects to attribute only after first render.
    /** @type {Record<string, string>} */
    const currentValues = {}
    const dynamicOptionsContainer = ui.extractionOptions.querySelector('[name="dynamicOptions"]')
    if (dynamicOptionsContainer) {
      for (const el of dynamicOptionsContainer.querySelectorAll('sl-select, sl-input')) {
        const name = /** @type {any} */(el).name
        if (name) currentValues[name] = /** @type {any} */(el).value
      }
      dynamicOptionsContainer.innerHTML = ""
    }
    if (!selectedExtractor || !selectedExtractor.options) return

    // Track intended values for options built so far (for depends evaluation).
    // We store chosenValue returned from createOptionElement, not element.value,
    // because Shoelace may not apply the value until after its first render cycle.
    /** @type {Record<string, string>} */
    const builtValues = {}
    /** @type {Array<[Element, string]>} */
    const pendingValues = []

    // Generate UI elements for each extractor option (except doi which is handled separately)
    for (const [optionKey, optionConfig] of Object.entries(selectedExtractor.options)) {
      if (optionKey === 'doi') continue // DOI is handled separately

      const result = createOptionElement(optionKey, optionConfig, selectedExtractorId, currentValues, builtValues)
      if (result && dynamicOptionsContainer) {
        const {element, chosenValue} = result
        builtValues[optionKey] = chosenValue
        dynamicOptionsContainer.appendChild(element)
        pendingValues.push([element, chosenValue])
        // Re-run dynamic options when any dynamic select changes (for depends conditions)
        element.addEventListener('sl-change', updateDynamicOptions)
      }
    }

    // Re-apply values after Shoelace has completed its first render cycle.
    // Setting value before or during DOM insertion is unreliable for Lit-based components.
    requestAnimationFrame(() => {
      for (const [element, value] of pendingValues) {
        /** @type {any} */(element).value = value
      }
    })
  }

  // Helper function to create form elements for extractor options.
  // Returns {element, chosenValue} so the caller can track the intended value
  // independently of element.value (which Shoelace may not apply until after render).
  /**
   * @param {string} optionKey
   * @param {ExtractorOption} optionConfig
   * @param {string} extractorId
   * @param {Record<string, string>} currentValues - Snapshot of values before the current re-render
   * @param {Record<string, string>} builtValues - Intended values of options already built in this pass
   * @returns {{element: SlSelect|SlInput, chosenValue: string}|null}
   */
  function createOptionElement(optionKey, optionConfig, extractorId, currentValues = {}, builtValues = {}) {
    // Skip this option if its depends condition is not met
    if (optionConfig.depends) {
      for (const [condKey, condVal] of Object.entries(optionConfig.depends)) {
        const actual = builtValues[condKey] ?? currentValues[condKey] ?? ''
        if (actual !== condVal) return null
      }
    }

    if (optionConfig.type === 'string' && (optionConfig.options || optionConfig.groups)) {
      // Create select dropdown for predefined options
      const select = Object.assign(new SlSelect, {
        name: optionKey,
        label: optionConfig.label || optionKey,
        size: "small"
      })

      if (optionConfig.description) {
        select.setAttribute("help-text", optionConfig.description)
      }

      /** @type {string[]} */
      const allValues = []

      if (optionConfig.groups) {
        // Render grouped options as flat list with "[provider] model" display text
        for (const group of optionConfig.groups) {
          for (const optionValue of group.options) {
            const value = `${group.label}/${optionValue}`
            const option = Object.assign(new SlOption, {
              value,
              textContent: `[${group.label}] ${optionValue}`
            })
            select.appendChild(option)
            allValues.push(value)
          }
        }
      } else if (optionConfig.options) {
        for (const optionValue of optionConfig.options) {
          const option = Object.assign(new SlOption, {
            value: optionValue,
            textContent: optionValue
          })
          select.appendChild(option)
          allValues.push(optionValue)
        }
      }

      // Determine chosen value: prefer previously selected value, then document metadata, then first option
      let chosenValue = ''
      if (currentValues[optionKey] && allValues.includes(currentValues[optionKey])) {
        chosenValue = currentValues[optionKey]
      } else {
        const variantId = documentMetadata.variant_id || options.variant_id
        if (optionKey === 'variant_id' && variantId && allValues.includes(variantId)) {
          chosenValue = variantId
        } else if (optionKey === 'flavor' && documentMetadata.extractor_flavor &&
                   allValues.includes(documentMetadata.extractor_flavor)) {
          chosenValue = documentMetadata.extractor_flavor
        } else if (allValues.length > 0) {
          chosenValue = allValues[0]
        }
      }

      return {element: select, chosenValue}
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

      return {element: select, chosenValue: "0"}
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

      return {element: input, chosenValue: currentValues[optionKey] ?? ''}
    }

    return null
  }
  
  modelSelectBox.addEventListener('sl-change', updateDynamicOptions)

  // Initial population of dynamic options
  updateDynamicOptions()

  // Display the dialog and loop until valid input or cancellation
  ui.extractionOptions.show()

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await new Promise(resolve => {
      function cancel() { resolve(false) }
      function submit() { resolve(true) }
      ui.extractionOptions.addEventListener("sl-request-close", cancel, { once: true })
      ui.extractionOptions.cancel.addEventListener("click", cancel, { once: true })
      ui.extractionOptions.submit.addEventListener("click", submit, { once: true })
    })

    if (result === false) {
      ui.extractionOptions.hide()
      modelSelectBox.removeEventListener('sl-change', updateDynamicOptions)
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

      // Skip empty variant_id values - they'll be provided from options/state
      if (name === 'variant_id' && (!value || value === '')) {
        continue
      }

      formData[name] = String(value)
    }

    // Check if selected extractor is XML-based (doesn't need DOI)
    const selectedExtractor = availableExtractors.find(e => e.id === formData.extractor)
    const isXmlExtractor = selectedExtractor && selectedExtractor.input.includes("xml")

    // Normalize and validate DOI if one is provided and not using an XML extractor
    if (!isXmlExtractor && formData.doi) {
      const extracted = extractDoi(formData.doi)
      if (extracted) {
        formData.doi = extracted
      } else {
        dialog.error(`"${formData.doi}" does not seem to be a valid DOI. Please correct it or leave the field empty.`)
        continue  // keep dialog open, let user correct
      }
    }

    // If DOI is empty or using XML extractor, set it to null for the request
    if (!formData.doi || formData.doi === "" || isXmlExtractor) {
      formData.doi = null
    }

    ui.extractionOptions.hide()
    modelSelectBox.removeEventListener('sl-change', updateDynamicOptions)
    return Object.assign(options, formData)
  }
}



/**
 * Extract DOI from a PDF filename. Strips the .pdf extension and decodes
 * URI components before calling extractDoi, which handles filename encoding.
 * @param {string} filename
 * @returns {string|null}
 */
function getDoiFromFilename(filename) {
  if (!filename) return null;
  const candidate = decodeURIComponent(filename.toLowerCase().split('.pdf')[0]);
  return extractDoi(candidate);
}