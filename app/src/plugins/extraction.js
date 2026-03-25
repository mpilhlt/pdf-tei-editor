/**
 * This implements the UI and the services for extracting references from the current or a new PDF
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { extractionActionsPart } from '../templates/extraction-buttons.types.js'
 * @import { extractionOptionsPart } from '../templates/extraction-dialog.types.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import { testLog } from '../modules/test-log.js'
import { SlSelect, SlOption, SlInput, updateUi } from '../ui.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import ui from '../ui.js'
import { extractDoi } from '../modules/doi-utils.js'
import { UserAbortException } from '../modules/utils.js'
import { getDocumentMetadata } from '../modules/tei-utils.js'
import { getFileDataById } from '../modules/file-data-utils.js'

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

// Register templates at module level
await registerTemplate('extraction-buttons', 'extraction-buttons.html')
await registerTemplate('extraction-dialog', 'extraction-dialog.html')

class ExtractionPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'extraction', deps: ['services', 'file-selection', 'logger', 'dialog'] })
  }

  static extensionPoints = [ep.toolbar.contentItems];

  [ep.toolbar.contentItems]() {
    return [{ element: this.#ui, priority: 7, position: 'center' }]
  }

  get #client()    { return this.getDependency('client') }
  get #services()  { return this.getDependency('services') }
  get #xmlEditor() { return this.getDependency('xmleditor') }

  /** @type {HTMLElement & extractionActionsPart} */
  #ui = null
  /** @type {import('../ui.js').SlDialog & extractionOptionsPart} */
  #dialogUi = null

  /** @type {ExtractorInfo[]|undefined} */
  #extractors

  /** @param {ApplicationState} _state */
  async install(_state) {
    await super.install(_state)
    this.getDependency('logger').debug(`Installing plugin "extraction"`)

    const extractionBtnGroup = createSingleFromTemplate('extraction-buttons')
    const dialog = createSingleFromTemplate('extraction-dialog', document.body)
    this.#ui = this.createUi(extractionBtnGroup)
    this.#dialogUi = this.createUi(dialog)

    ui.toolbar.add(extractionBtnGroup, 7)
    updateUi()

    this.#ui.extractNew.addEventListener('click', () => this.extractFromNewPdf())
    this.#ui.extractCurrent.addEventListener('click', () => this.extractFromCurrentPDF())
  }

  async onStateUpdate(_changedKeys) {
    this.#ui.childNodes.forEach(child => {
      if (child instanceof HTMLElement && 'disabled' in child) {
        /** @type {HTMLButtonElement} */(child).disabled = this.state.offline
      }
    })
    this.#ui.extractCurrent.disabled = !this.state.pdf
  }

  /**
   * Add a button to the extraction actions button group.
   * Used by plugins that contribute buttons to the extraction toolbar area.
   * @param {HTMLElement} element
   */
  addButton(element) {
    this.#ui.append(element)
  }

  /**
   * Extract references from the currently loaded PDF
   */
  async extractFromCurrentPDF() {
    await this.extractFromPDF()
  }

  /**
   * Upload a new PDF and extract from it
   */
  async extractFromNewPdf() {
    try {
      const { type, filename, originalFilename } = await this.#client.uploadFile()
      if (type !== 'pdf') {
        this.getDependency('dialog').error('Extraction is only possible from PDF files')
        return
      }
      testLog('PDF_UPLOAD_COMPLETED', { originalFilename, filename, type })
      const doi = getDoiFromFilename(originalFilename)
      await this.extractFromPDF({ doi, filename })
    } catch (error) {
      throw error
    }
  }

  /**
   * Extracts references from the given source file (PDF or XML), letting the user choose the extraction options
   * @param {ExtractionOptions} [defaultOptions] Optional default option object passed to the extraction service,
   * user will be prompted to choose own ones.
   * @throws {UserAbortException} If the user cancels the form
   * @throws {Error} For all other errors
   */
  async extractFromPDF(defaultOptions = {}) {
    const state = this.state
    try {
      if (!state.pdf && !defaultOptions.filename && !state.xml) {
        throw new Error('Missing source file: no PDF path or XML content available')
      }

      let doi = defaultOptions.doi
      if (!doi) {
        try {
          const xmlDoc = this.#xmlEditor.getXmlTree()
          if (xmlDoc) {
            const metadata = getDocumentMetadata(xmlDoc)
            doi = metadata.doi
          }
        } catch (error) {
          console.warn('Cannot get DOI from document:', String(error))
        }

        if (!doi && defaultOptions.filename) {
          doi = getDoiFromFilename(defaultOptions.filename)
        }

        if (!doi) {
          const fileId = state.pdf || state.xml
          const docId = fileId ? getFileDataById(fileId)?.file?.doc_id : null
          if (docId) {
            doi = extractDoi(docId)
          }
        }
      }

      const enhancedOptions = {
        collection: state.collection,
        variant_id: state.variant,
        doi,
        ...defaultOptions
      }

      testLog('EXTRACTION_OPTIONS_DIALOG_STARTING', { enhancedOptions })
      const options = await this.#promptForExtractionOptions(enhancedOptions)

      ui.spinner.show('Extracting, please wait')
      let result
      try {
        const extractorList = await this.#client.getExtractorList()
        const selectedExtractor = extractorList.find(e => e.id === options.extractor)
        const needsXmlContent = selectedExtractor && selectedExtractor.input.includes('xml')

        let file_id
        if (needsXmlContent && state.xml) {
          file_id = state.xml
        } else {
          file_id = options.filename || state.pdf
        }

        if (!file_id) {
          throw new Error('No source file available for extraction')
        }

        result = await this.#client.extract(file_id, options)

        await this.getDependency('file-selection').reload({ refresh: true })

        if (options && options.variant_id) {
          await this.dispatchStateChange({ variant: options.variant_id })
        }

        /** @type {ExtractionResult} */
        const typedResult = /** @type {ExtractionResult} */(result)
        if (typedResult && typedResult.pdf === null) {
          await this.dispatchStateChange({ pdf: null })
        }
        await this.#services.load(result)

        testLog('EXTRACTION_COMPLETED', { resultHash: typedResult.xml, sourceFileId: file_id })
      } finally {
        ui.spinner.hide()
      }
    } catch (error) {
      console.error(String(error))
      if (error instanceof UserAbortException) {
        return
      }
      this.getDependency('dialog').error(String(error))
    }
  }

  /**
   * Returns the cached list of extractor info objects
   * @returns {ExtractorInfo[]|undefined}
   */
  extractorInfo() {
    return this.#extractors
  }

  /**
   * @param {ExtractionOptions} options
   * @returns {Promise<ExtractionOptions>}
   */
  async #promptForExtractionOptions(options = {}) {
    const state = this.state
    const dialog = this.getDependency('dialog')
    const logger = this.getDependency('logger')
    const dialogUi = this.#dialogUi

    const instructionsData = await this.#client.loadInstructions()
    /** @type {string[]} */
    const instructions = []

    /** @type {DocumentMetadata} */
    let documentMetadata = {}
    try {
      const xmlDoc = this.#xmlEditor.getXmlTree()
      if (xmlDoc) {
        documentMetadata = getDocumentMetadata(xmlDoc)
      }
    } catch (error) {
      console.warn('Could not extract document metadata:', String(error))
    }

    const doiValue = options.doi || documentMetadata.doi || ''
    dialogUi.doi.value = doiValue

    /** @type {SlSelect} */
    const collectionSelectBox = dialogUi.collectionName
    collectionSelectBox.innerHTML = ''

    const collections = state?.collections || []
    for (const collection of collections) {
      const option = Object.assign(new SlOption, {
        value: collection.id,
        textContent: collection.name
      })
      collectionSelectBox.append(option)
    }

    const collectionValue = options.collection || (collections.length > 0 ? collections[0].id : '_inbox')
    collectionSelectBox.value = collectionValue

    /** @type {SlSelect} */
    const modelSelectBox = dialogUi.modelIndex
    modelSelectBox.innerHTML = ''

    let availableExtractors = []
    try {
      if (!this.#extractors) {
        this.#extractors = await this.#client.getExtractorList()
      }

      availableExtractors = this.#extractors.filter(extractor => {
        const supportsPdf = extractor.input.includes('pdf') && (state?.pdf || options.filename)
        const supportsXml = extractor.input.includes('xml') && state?.xml
        return supportsPdf || supportsXml
      })

      for (const extractor of availableExtractors) {
        const option = Object.assign(new SlOption, {
          value: extractor.id,
          textContent: extractor.name
        })
        modelSelectBox.appendChild(option)
      }

      if (availableExtractors.length > 0) {
        let defaultExtractor = availableExtractors[0].id
        const variantId = documentMetadata.variant_id || options.variant_id
        if (variantId) {
          const extractorForVariant = availableExtractors.find(extractor => {
            const variantOptions = extractor.options?.variant_id?.options
            return Array.isArray(variantOptions) && variantOptions.includes(variantId)
          })
          if (extractorForVariant) {
            defaultExtractor = extractorForVariant.id
          }
        }
        modelSelectBox.value = defaultExtractor
      }
    } catch (error) {
      logger.warn('Could not load extraction engines: ' + String(error))
      modelSelectBox.disabled = true
      availableExtractors = []
    }

    const updateDynamicOptions = () => {
      const selectedExtractorId = String(modelSelectBox.value)
      if (!selectedExtractorId) return

      const selectedExtractor = availableExtractors.find(e => e.id === selectedExtractorId)

      const isXmlExtractor = selectedExtractor && selectedExtractor.input.includes('xml')
      const doiEl = /** @type {HTMLElement} */(dialogUi.doi)
      const collectionEl = /** @type {HTMLElement} */(collectionSelectBox.parentElement)
      doiEl.style.display = isXmlExtractor ? 'none' : ''
      if (collectionEl) collectionEl.style.display = isXmlExtractor ? 'none' : ''

      /** @type {Record<string, string>} */
      const currentValues = {}
      const dynamicOptionsContainer = dialogUi.dynamicOptions
      if (dynamicOptionsContainer) {
        for (const el of dynamicOptionsContainer.querySelectorAll('sl-select, sl-input')) {
          const name = /** @type {any} */(el).name
          if (name) currentValues[name] = /** @type {any} */(el).value
        }
        dynamicOptionsContainer.innerHTML = ''
      }
      if (!selectedExtractor || !selectedExtractor.options) return

      /** @type {Record<string, string>} */
      const builtValues = {}
      /** @type {Array<[Element, string]>} */
      const pendingValues = []

      for (const [optionKey, optionConfig] of Object.entries(selectedExtractor.options)) {
        if (optionKey === 'doi') continue

        const result = createOptionElement(optionKey, optionConfig, selectedExtractorId, currentValues, builtValues)
        if (result && dynamicOptionsContainer) {
          const { element, chosenValue } = result
          builtValues[optionKey] = chosenValue
          dynamicOptionsContainer.appendChild(element)
          pendingValues.push([element, chosenValue])
          element.addEventListener('sl-change', updateDynamicOptions)
        }
      }

      requestAnimationFrame(() => {
        for (const [element, value] of pendingValues) {
          /** @type {any} */(element).value = value
        }
      })
    }

    /**
     * @param {string} optionKey
     * @param {ExtractorOption} optionConfig
     * @param {string} extractorId
     * @param {Record<string, string>} currentValues
     * @param {Record<string, string>} builtValues
     * @returns {{element: SlSelect|SlInput, chosenValue: string}|null}
     */
    function createOptionElement(optionKey, optionConfig, extractorId, currentValues = {}, builtValues = {}) {
      if (optionConfig.depends) {
        for (const [condKey, condVal] of Object.entries(optionConfig.depends)) {
          const actual = builtValues[condKey] ?? currentValues[condKey] ?? ''
          if (actual !== condVal) return null
        }
      }

      if (optionConfig.type === 'string' && (optionConfig.options || optionConfig.groups)) {
        const select = Object.assign(new SlSelect, {
          name: optionKey,
          label: optionConfig.label || optionKey,
          size: 'small'
        })

        if (optionConfig.description) {
          select.setAttribute('help-text', optionConfig.description)
        }

        /** @type {string[]} */
        const allValues = []

        if (optionConfig.groups) {
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

        return { element: select, chosenValue }
      } else if (optionKey === 'instructions' && extractorId && instructionsData) {
        const select = Object.assign(new SlSelect, {
          name: 'instructions',
          label: 'Instructions',
          size: 'small'
        })
        select.setAttribute('help-text', 'Choose the instruction set that is added to the prompt')

        let instructionIndex = 0
        for (const instructionData of instructionsData) {
          /** @type {InstructionData} */
          const instructionDataTyped = /** @type {InstructionData} */(instructionData)
          const { label, text, extractor = [] } = instructionDataTyped

          if (extractor.includes(extractorId)) {
            const option = Object.assign(new SlOption, {
              value: String(instructionIndex),
              textContent: label
            })
            instructions[instructionIndex] = text.join('\n')
            select.appendChild(option)
            instructionIndex++
          }
        }

        if (instructionIndex === 0) {
          const option = Object.assign(new SlOption, {
            value: '0',
            textContent: 'No custom instructions'
          })
          instructions[0] = ''
          select.appendChild(option)
        }

        return { element: select, chosenValue: '0' }
      } else if (optionConfig.type === 'string') {
        const input = Object.assign(new SlInput, {
          name: optionKey,
          label: optionConfig.label || optionKey,
          size: 'small',
          type: 'text'
        })

        if (optionConfig.description) {
          input.setAttribute('help-text', optionConfig.description)
        }

        return { element: input, chosenValue: currentValues[optionKey] ?? '' }
      }

      return null
    }

    modelSelectBox.addEventListener('sl-change', updateDynamicOptions)
    updateDynamicOptions()

    dialogUi.show()

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await new Promise(resolve => {
        function cancel() { resolve(false) }
        function submit() { resolve(true) }
        dialogUi.addEventListener('sl-request-close', cancel, { once: true })
        dialogUi.cancel.addEventListener('click', cancel, { once: true })
        dialogUi.submit.addEventListener('click', submit, { once: true })
      })

      if (result === false) {
        dialogUi.hide()
        modelSelectBox.removeEventListener('sl-change', updateDynamicOptions)
        throw new UserAbortException('User cancelled the dialog')
      }

      /** @type {DynamicExtractionFormData} */
      const formData = {
        doi: dialogUi.doi.value || null,
        collection: String(dialogUi.collectionName.value),
        extractor: String(dialogUi.modelIndex.value)
      }

      const dynamicOptionsContainer = dialogUi.dynamicOptions
      /** @type {NodeListOf<SlSelect|SlInput>} */
      const dynamicInputs = /** @type {NodeListOf<SlSelect|SlInput>} */(dynamicOptionsContainer?.querySelectorAll('sl-select, sl-input') || [])

      for (const input of dynamicInputs) {
        /** @type {SlSelect|SlInput} */
        const typedInput = /** @type {SlSelect|SlInput} */(input)
        const name = typedInput.name
        let value = typedInput.value

        if (name === 'instructions' && instructions[parseInt(String(value))]) {
          value = instructions[parseInt(String(value))]
        }

        if (name === 'variant_id' && (!value || value === '')) {
          continue
        }

        formData[name] = String(value)
      }

      const selectedExtractor = availableExtractors.find(e => e.id === formData.extractor)
      const isXmlExtractor = selectedExtractor && selectedExtractor.input.includes('xml')

      if (!isXmlExtractor && formData.doi) {
        const extracted = extractDoi(formData.doi)
        if (extracted) {
          formData.doi = extracted
        } else {
          dialog.error(`"${formData.doi}" does not seem to be a valid DOI. Please correct it or leave the field empty.`)
          continue
        }
      }

      if (!formData.doi || formData.doi === '' || isXmlExtractor) {
        formData.doi = null
      }

      dialogUi.hide()
      modelSelectBox.removeEventListener('sl-change', updateDynamicOptions)
      return Object.assign(options, formData)
    }
  }
}

/**
 * Extract DOI from a PDF filename. Strips the .pdf extension and decodes
 * URI components before calling extractDoi, which handles filename encoding.
 * @param {string} filename
 * @returns {string|null}
 */
function getDoiFromFilename(filename) {
  if (!filename) return null
  const candidate = decodeURIComponent(filename.toLowerCase().split('.pdf')[0])
  return extractDoi(candidate)
}

export default ExtractionPlugin

export const plugin = ExtractionPlugin

