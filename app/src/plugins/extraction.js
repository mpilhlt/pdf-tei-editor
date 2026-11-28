/**
 * This implements the UI and the services for extracting references from the current or a new PDF
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { extractionActionsPart } from '../templates/extraction-buttons.types.js'
 * @import { extractionOptionsPart } from '../templates/extraction-dialog.types.js'
 * @import { OcrRunOptions, OcrSettings } from './ocr.js'
 * @import { ExtractJobResult, Job, OcrEngineInfo, OcrRequest, TextQualityReport, LanguageConflict } from '../modules/api-client-v1.js'
 * @import { ShownDocuments } from '../modules/background-result.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import { testLog } from '../modules/test-log.js'
import { SlSelect, SlOption, SlInput } from '../ui.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import ui from '../ui.js'
import { extractDoi } from '../modules/doi-utils.js'
import { UserAbortException } from '../modules/utils.js'
import { getDocumentMetadata } from '../modules/tei-utils.js'
import { getFileDataById } from '../modules/file-data-utils.js'
import { notify } from '../modules/sl-utils.js'
import { languageName } from '../modules/language-chooser.js'
import { JobCancelledError, JobFailedError } from '../modules/job-client.js'
import { loadWhenFinished } from '../modules/background-result.js'

/**
 * Extractor configuration object
 * @typedef {object} ExtractorInfo
 * @property {string} id - Unique identifier for the extractor
 * @property {string} name - Display name for the extractor
 * @property {string[]} input - Supported input types (e.g., ['pdf'])
 * @property {string[]} output - Supported output types (e.g., ['tei-document'])
 * @property {boolean} [uses_inference_model] - Whether the extractor runs on the model chosen under Tools > Default Model
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
 * Extraction result object
 * @typedef {object} ExtractionResult
 * @property {string} xml - Hash or content of the extracted XML
 * @property {string|null} [pdf] - stable_id of the source PDF; null if the result has none
 * @property {LanguageConflict|null} [language_conflict] - Set if the declared language contradicts the language of the text
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
 * @property {Record<string, any>} [dynamicOptions] - Additional extractor-specific options
 * @property {OcrRunOptions} [ocr] - If set, text recognition is applied to the PDF before extraction (not sent to the extractor)
 */

// Register templates at module level
await registerTemplate('extraction-buttons', 'extraction-buttons.html')
await registerTemplate('extraction-dialog', 'extraction-dialog.html')

class ExtractionPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'extraction', deps: ['services', 'file-selection', 'logger', 'dialog', 'api-keys', 'ocr', 'jobs'] })
  }

  static extensionPoints = [ep.toolbar.contentItems];

  /**
   * Extension point handler for `ep.toolbar.contentItems`.
   * Called by ToolbarPlugin during start() to collect this plugin's toolbar contribution.
   * @returns {Array<{element: HTMLElement, priority: number, position: string}>}
   */
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
      const { type, filename, originalFilename, doc_id } = await this.#client.uploadFile()
      if (type !== 'pdf') {
        this.getDependency('dialog').error('Extraction is only possible from PDF files')
        return
      }
      testLog('PDF_UPLOAD_COMPLETED', { originalFilename, filename, type })
      // Prefer the server-resolved doc_id (may include DOI extracted from PDF content)
      // over the DOI parsed from the original filename.
      const doi = (doc_id ? extractDoi(doc_id) : null) || getDoiFromFilename(originalFilename)
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
      const { ocr, ...options } = await this.#promptForExtractionOptions(enhancedOptions)
      // the documents shown when the extraction started, to tell whether the user opened others meanwhile
      const started = { pdf: state.pdf, xml: state.xml }

      // the spinner covers the preparation only; the job runs in the background, with the
      // progress widget that the jobs plugin shows for it
      const spinnerMessage = 'Preparing the extraction, please wait'
      ui.spinner.show(spinnerMessage)
      /** @type {Job} */
      let job
      /** @type {OcrRequest|null} */
      let ocrRequest = null
      let fileId
      let extractorName
      try {
        const extractorList = await this.#client.getExtractorList()
        const selectedExtractor = extractorList.find(e => e.id === options.extractor)
        const needsXmlContent = selectedExtractor && selectedExtractor.input.includes('xml')
        extractorName = selectedExtractor?.name ?? options.extractor

        const extractsFromXml = Boolean(needsXmlContent && state.xml)
        fileId = extractsFromXml ? state.xml : (options.filename || state.pdf)
        if (!fileId) {
          throw new Error('No source file available for extraction')
        }

        if (ocr && !extractsFromXml) {
          // Text recognition can take minutes, so first make sure that the extractor can run
          // (e.g. that the service it uses is reachable)
          const check = await this.#client.apiClient.extractCheck({ extractor: options.extractor, options })
          testLog('EXTRACTOR_CHECKED', { extractor: options.extractor, ready: check.ready, message: check.message ?? null })
          if (!check.ready) {
            throw new Error(`${extractorName} cannot be used at the moment, so text recognition was not started: ${check.message}`)
          }
          ocrRequest = this.getDependency('ocr').createRequest(fileId, ocr)
        }

        const sourceId = fileId
        job = await this.getDependency('api-keys').withKeyPrompt(
          () => this.#client.extractJob(sourceId, options, ocrRequest),
          // the blocker would cover the key dialog
          { before: () => ui.spinner.hide(), after: () => ui.spinner.show(spinnerMessage) }
        )
      } finally {
        ui.spinner.hide()
      }
      await this.#finishExtractionJob(job, fileId, options, ocrRequest, started)
    } catch (error) {
      console.error(String(error))
      if (error instanceof UserAbortException) {
        return
      }
      this.getDependency('dialog').error(String(error))
    }
  }

  /**
   * Waits for an extraction job, which runs in the background while the user can go on working;
   * the `jobs` plugin shows its progress widget, whose cancel button cancels it. With text
   * recognition, cancelling before its result is stored leaves the PDF unchanged; cancelling later
   * keeps the new PDF and extracts nothing.
   *
   * When it is finished, the result is loaded if the user still has the documents open that were
   * shown when it started; otherwise the user is asked whether to load it (see {@link #loadWhenFinished}).
   * @param {Job} job - The submitted job (type `extract`)
   * @param {string} fileId - stable_id of the source file
   * @param {ExtractionOptions} options - Extraction options without `ocr`
   * @param {OcrRequest|null} ocrRequest - The text recognition of the job, if any
   * @param {ShownDocuments} started - The documents shown when the extraction started
   * @returns {Promise<void>}
   * @throws {Error} An ApiError or ServerError if the job failed
   */
  async #finishExtractionJob(job, fileId, options, ocrRequest, started) {
    const client = this.#client
    testLog('EXTRACTION_JOB_SUBMITTED', { jobId: job.id, stableId: fileId, ocr: Boolean(ocrRequest) })
    /** @type {ExtractJobResult} */
    let result
    try {
      result = /** @type {ExtractJobResult} */ (await this.getDependency('jobs').wait(job.id))
    } catch (error) {
      if (error instanceof JobCancelledError) {
        testLog('EXTRACTION_CANCELLED', { jobId: job.id, stableId: fileId })
        notify(ocrRequest ? 'Text recognition was cancelled. The PDF is unchanged.' : 'The extraction was cancelled.', 'primary', 'info-circle')
        return
      }
      if (error instanceof JobFailedError) {
        testLog('EXTRACTION_FAILED', { jobId: job.id, stableId: fileId, error: error.message, status: error.status })
        throw error.status < 500 ? new client.ApiError(error.message, error.status) : new client.ServerError(error.message, error.status)
      }
      throw error
    }

    const ocrResult = result.ocr
    if (ocrResult) {
      this.getDependency('ocr').reportResult(fileId, ocrResult, Boolean(ocrRequest?.llm_correction))
      if (ocrResult.method === 'force' && ocrResult.fallback_reason) {
        notify(`The pages were converted to images, since ${ocrResult.fallback_reason}.`, 'warning', 'exclamation-triangle', 10000)
      }
    }
    if (!result.xml) {
      // cancelled after the OCR result was stored as a new PDF of the document (#944), which no
      // version is attached to yet; nothing was extracted
      testLog('EXTRACTION_CANCELLED', { jobId: job.id, stableId: fileId, ocrKept: Boolean(ocrResult) })
      if (!ocrResult) return
      const finishedMessage = ocrResult.llm_correction_cancelled
        ? 'Text recognition is finished (the correction was cancelled).'
        : 'Text recognition is finished (the extraction was cancelled).'
      await this.#loadWhenFinished(started, finishedMessage, () => this.#services.load({ pdf: ocrResult.stable_id, xml: null }))
      return
    }

    /** @type {ExtractionResult} */
    const extracted = { xml: result.xml, pdf: result.pdf ?? null, language_conflict: result.language_conflict ?? null }
    const loaded = await this.#loadWhenFinished(started,
      ocrResult ? 'Text recognition and extraction are finished.' : 'The extraction is finished.',
      () => this.#loadExtractionResult(extracted, options, fileId))
    if (loaded && extracted.language_conflict) {
      await this.#resolveLanguageConflict(extracted.language_conflict)
    }
  }

  /**
   * Loads the result of a process that ran in the background, see {@link loadWhenFinished}.
   * @param {ShownDocuments} started - The documents shown when the process started
   * @param {string} finishedMessage - Says which process is finished
   * @param {() => Promise<void>} load - Loads the result
   * @returns {Promise<boolean>} Whether the result was loaded
   */
  async #loadWhenFinished(started, finishedMessage, load) {
    return loadWhenFinished({
      started,
      current: { pdf: this.state.pdf, xml: this.state.xml },
      finishedMessage,
      confirm: message => this.getDependency('dialog').confirm(message, 'Finished'),
      refreshFileList: () => this.getDependency('file-selection').reload({ refresh: true }),
      load
    })
  }

  /**
   * Shows the result of an extraction: updates the file list, switches to the extracted variant and
   * loads the new document
   * @param {ExtractionResult} result
   * @param {ExtractionOptions} options - The extraction options
   * @param {string} fileId - stable_id of the source file
   * @returns {Promise<void>}
   */
  async #loadExtractionResult(result, options, fileId) {
    await this.getDependency('file-selection').reload({ refresh: true })

    if (options && options.variant_id) {
      await this.dispatchStateChange({ variant: options.variant_id })
    }

    if (result && result.pdf === null) {
      await this.dispatchStateChange({ pdf: null })
    }
    await this.#services.load(result)

    testLog('EXTRACTION_COMPLETED', { resultHash: result.xml, sourceFileId: fileId })
  }

  /**
   * Asks the user whether to declare the language detected from the text of the document
   * instead of the declared one (e.g. from CrossRef), and if so, changes it in the editor and saves.
   * @param {LanguageConflict} conflict - The declared and the detected language
   * @returns {Promise<void>}
   */
  async #resolveLanguageConflict({ declared, detected }) {
    const declaredName = languageName(declared)
    const detectedName = languageName(detected)
    const accepted = await this.getDependency('dialog').confirm(
      `The bibliographic metadata declare the language of this document as ${declaredName}, but its text reads as ${detectedName}. Declare ${detectedName} as the language of the document?`,
      'Document language'
    )
    testLog('LANGUAGE_CONFLICT_RESOLVED', { declared, detected, accepted })
    if (!accepted) return
    const xmlTree = this.#xmlEditor.getXmlTree()
    const language = xmlTree && Array.from(xmlTree.getElementsByTagName('langUsage'))
      .flatMap(langUsage => Array.from(langUsage.getElementsByTagName('language')))[0]
    if (!language) {
      this.getDependency('logger').warn('The document has no langUsage/language element to change')
      return
    }
    language.setAttribute('ident', detected)
    await this.#xmlEditor.updateEditorFromNode(language)
    await this.#xmlEditor.saveIfDirty()
    testLog('DOCUMENT_LANGUAGE_CHANGED', { language: detected })
    notify(`The language of the document was changed to ${detectedName}.`, 'success', 'check-circle')
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
    // Looked up lazily rather than declared in `deps`: only needed while the dialog is open
    const inferenceSettings = this.getDependency('inference-settings')

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
      if (!this.#extractors?.length) {
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

      modelSelectBox.helpText = availableExtractors.length > 0
        ? 'Choose the extraction engine'
        : 'No extraction engine is installed for this document type. Extraction requires an extractor plugin.'

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

    /**
     * Whether the extractor will read the PDF, using the same rule as {@link ExtractionPlugin#extractFromPDF}
     * for choosing the source file
     * @param {ExtractorInfo|undefined} extractor
     * @returns {boolean}
     */
    const extractsFromPdf = extractor => !extractor ||
      (extractor.input.includes('pdf') && !(extractor.input.includes('xml') && state?.xml))

    const xmlDoc = (() => {
      try { return this.#xmlEditor.getXmlTree() } catch { return null }
    })()
    // The open document only describes the PDF if no new PDF was uploaded
    const ocrSection = this.#setupOcrSection(
      options.filename || state?.pdf || null,
      options.filename ? [] : getDocumentLanguages(xmlDoc)
    )

    const updateDynamicOptions = () => {
      const selectedExtractorId = String(modelSelectBox.value)
      const selectedExtractor = availableExtractors.find(e => e.id === selectedExtractorId)
      const isXmlExtractor = selectedExtractor && selectedExtractor.input.includes('xml')
      ocrSection.update(extractsFromPdf(selectedExtractor))
      if (!selectedExtractorId) return

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

        const result = createOptionElement(optionKey, optionConfig, currentValues, builtValues)
        if (result && dynamicOptionsContainer) {
          const { element, chosenValue } = result
          builtValues[optionKey] = chosenValue
          dynamicOptionsContainer.appendChild(element)
          pendingValues.push([element, chosenValue])
          element.addEventListener('sl-change', updateDynamicOptions)
        }
      }

      if (selectedExtractor.uses_inference_model && dynamicOptionsContainer) {
        dynamicOptionsContainer.appendChild(createInferenceModelDisplay())
      }

      requestAnimationFrame(() => {
        for (const [element, value] of pendingValues) {
          /** @type {any} */(element).value = value
        }
      })
    }

    /**
     * Read-only display of the LLM model an extractor with `uses_inference_model`
     * will run on. Has no `name`, so it is not submitted as an option.
     * @returns {SlInput}
     */
    function createInferenceModelDisplay() {
      const model = inferenceSettings.getDefaultModel()
      const input = Object.assign(new SlInput, {
        label: 'Model',
        size: 'small',
        type: 'text',
        readonly: true,
        value: model ? inferenceSettings.getModelLabel(model.providerId, model.modelId) : 'Server default'
      })
      input.setAttribute('help-text', 'Change under Tools > Default Model')
      return input
    }

    /**
     * @param {string} optionKey
     * @param {ExtractorOption} optionConfig
     * @param {Record<string, string>} currentValues
     * @param {Record<string, string>} builtValues
     * @returns {{element: SlSelect|SlInput, chosenValue: string}|null}
     */
    function createOptionElement(optionKey, optionConfig, currentValues = {}, builtValues = {}) {
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
        ocrSection.dispose()
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
        if (!name) continue
        let value = typedInput.value

        if (name === 'variant_id' && (!value || value === '')) {
          continue
        }

        formData[name] = String(value)
      }

      const selectedExtractor = availableExtractors.find(e => e.id === formData.extractor)
      if (selectedExtractor?.uses_inference_model) {
        // Without a client-side choice the server uses the configured default model
        const model = inferenceSettings.getDefaultModel()
        if (model) {
          formData.provider_id = model.providerId
          formData.model_id = model.modelId
        }
      }
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

      const ocr = extractsFromPdf(selectedExtractor) ? ocrSection.getRunOptions() : null
      dialogUi.hide()
      modelSelectBox.removeEventListener('sl-change', updateDynamicOptions)
      ocrSection.dispose()
      Object.assign(options, formData)
      if (ocr) {
        options.ocr = ocr
      } else {
        delete options.ocr
      }
      testLog('EXTRACTION_OPTIONS_SUBMITTED', { extractor: formData.extractor, ocr })
      return options
    }
  }

  /**
   * Set up the text recognition section of the extraction dialog: checks the text layer of
   * the PDF, fills the engine list and wires the "Configure OCR options" button.
   *
   * If the PDF has no text layer, the checkbox is checked and cannot be unchecked; if the text
   * layer is of poor quality, it is checked but can be unchecked.
   *
   * @param {string|null} pdfStableId - stable_id of the PDF, null if there is none
   * @param {string[]} languageHints - Languages declared in the current document, used as default OCR languages
   * @returns {{update: (visible: boolean) => void, getRunOptions: () => OcrRunOptions|null, dispose: () => void}}
   */
  #setupOcrSection(pdfStableId, languageHints) {
    const section = this.#dialogUi.ocrSection
    const loading = this.#dialogUi.ocrLoading
    const ocrPlugin = this.getDependency('ocr')
    const logger = this.getDependency('logger')
    const controller = new AbortController()
    const signal = controller.signal

    /** @type {OcrEngineInfo[]} */
    let engines = []
    let enginesLoaded = false
    /** @type {TextQualityReport|null} */
    let quality = null
    let userToggled = false
    let wanted = false
    /** @type {{engine: string, settings: OcrSettings}|null} settings chosen in the OCR dialog for this extraction */
    let chosen = null

    section.style.display = 'none'
    loading.style.display = 'none'
    section.applyOcr.checked = false
    section.applyOcr.disabled = true
    section.ocrEngine.innerHTML = ''
    renderTextQuality(section.textQuality, null, pdfStableId ? 'Checking the text layer…' : '')

    const hints = () => [...languageHints, quality?.language]
    const selectedEngine = () => engines.find(e => e.id === String(section.ocrEngine.value)) ?? null
    /** @param {OcrEngineInfo} engine */
    const settingsFor = engine => chosen?.engine === engine.id ? chosen.settings : ocrPlugin.getSettings(engine, hints())

    const updateLlmNote = () => {
      const note = section.applyOcr.checked ? ocrPlugin.getLlmCorrectionNote() : ''
      section.llmNote.textContent = note
      section.llmNote.style.display = note ? '' : 'none'
    }

    const render = () => {
      // Until the engine list is known, a placeholder shows that text recognition will be offered
      loading.style.display = wanted && !enginesLoaded ? '' : 'none'
      section.style.display = wanted && engines.length ? '' : 'none'
      const missing = quality?.status === 'missing'
      section.applyOcr.disabled = missing
      if (missing) {
        section.applyOcr.checked = true
      } else if (!userToggled && quality) {
        section.applyOcr.checked = quality.status === 'poor'
      }
      updateLlmNote()
    }

    /** @param {OcrEngineInfo[]} list */
    const showEngines = list => {
      engines = list
      enginesLoaded = true
      for (const engine of engines) {
        section.ocrEngine.append(Object.assign(new SlOption(), { value: engine.id, textContent: engine.name }))
      }
      const preferred = ocrPlugin.getPreferredEngine(engines)
      requestAnimationFrame(() => { section.ocrEngine.value = preferred ?? '' })
      render()
    }

    if (pdfStableId) {
      // The OCR plugin loads the engine list after login, so it is usually known already
      const loaded = ocrPlugin.getLoadedEngines()
      if (loaded) {
        showEngines(loaded)
      } else {
        ocrPlugin.getEngines()
          .then(list => {
            if (!signal.aborted) showEngines(list)
          })
          .catch(error => {
            logger.warn('Could not load OCR engines: ' + String(error))
            if (signal.aborted) return
            enginesLoaded = true
            render()
          })
      }
    }

    /** @param {unknown} error */
    const showCheckError = error => {
      if (signal.aborted) return
      renderTextQuality(section.textQuality, null, 'Could not check the text layer: ' + String(error))
      section.applyOcr.disabled = false
    }

    let checkStarted = false
    /**
     * Check the text layer once the section is shown, i.e. only for extractors that read the PDF:
     * first the fast character checks, then, if they found no problems, the comparison with the
     * words recognized on sample pages.
     */
    const checkTextLayer = () => {
      if (checkStarted || !pdfStableId) return
      checkStarted = true
      ocrPlugin.getTextQuality(pdfStableId)
        .then(report => {
          if (signal.aborted) return
          quality = report
          const checkLayout = report.status === 'good'
          renderTextQuality(section.textQuality, report, '', checkLayout ? 'Comparing the text layer with the page images…' : '')
          render()
          if (!checkLayout) return
          return ocrPlugin.getTextQuality(pdfStableId, { layout: true }).then(layoutReport => {
            if (signal.aborted) return
            quality = layoutReport
            renderTextQuality(section.textQuality, layoutReport)
            render()
          })
        })
        .catch(showCheckError)
    }

    section.applyOcr.addEventListener('sl-change', () => {
      userToggled = true
      updateLlmNote()
    }, { signal })
    section.ocrEngine.addEventListener('sl-change', () => {
      const engine = selectedEngine()
      if (engine) ocrPlugin.setPreferredEngine(engine.id)
      updateLlmNote()
    }, { signal })
    section.configureOcr.addEventListener('click', async () => {
      const engine = selectedEngine()
      if (!engine) return
      try {
        const settings = await ocrPlugin.configure(engine, settingsFor(engine))
        if (settings) chosen = { engine: engine.id, settings }
        updateLlmNote()
      } catch (error) {
        this.getDependency('dialog').error(String(error))
      }
    }, { signal })

    return {
      update: visible => {
        wanted = visible && Boolean(pdfStableId)
        if (wanted) checkTextLayer()
        render()
      },
      getRunOptions: () => {
        const engine = selectedEngine()
        if (!engine || !wanted || !section.applyOcr.checked) return null
        // Checking the box asks for a new text layer, even where the checks found no problem
        return { engine: engine.id, ...settingsFor(engine), rebuild: true }
      },
      dispose: () => controller.abort()
    }
  }
}

/**
 * Show the result of the text layer check in the extraction dialog.
 * @param {HTMLElement} container
 * @param {TextQualityReport|null} report
 * @param {string} [message] - Text to show instead of a report
 * @param {string} [pending] - Note about a check that is still running
 */
function renderTextQuality(container, report, message = '', pending = '') {
  container.innerHTML = ''
  container.dataset.status = report?.status ?? ''
  if (!report) {
    container.textContent = message
    return
  }
  const icons = { missing: 'exclamation-octagon', poor: 'exclamation-triangle', good: 'check-circle' }
  const icon = Object.assign(document.createElement('sl-icon'), { name: icons[report.status] })
  const summary = document.createElement('span')
  summary.textContent = report.summary
  container.append(icon, ' ', summary)
  const details = [...report.reasons]
  if (pending) {
    details.push(pending)
  } else if (report.layout_checked && report.status === 'good') {
    details.push('The text layer matches the words recognized on sample pages.')
  }
  if (report.ocr_applied) {
    const date = new Date(report.ocr_applied.applied_at).toLocaleString()
    details.push(`Text recognition was applied on ${date} (${report.ocr_applied.engine}, ${report.ocr_applied.languages.join(', ')}).`)
    if (report.ocr_applied.method === 'force') {
      const reason = report.ocr_applied.fallback_reason ? `, since ${report.ocr_applied.fallback_reason}` : ''
      details.push(`The pages were converted to images${reason}.`)
    }
  }
  if (details.length) {
    const list = document.createElement('ul')
    for (const detail of details) {
      list.append(Object.assign(document.createElement('li'), { textContent: detail }))
    }
    container.append(list)
  }
}

/**
 * Return the languages declared in profileDesc/langUsage of a TEI document. `xml:lang` is
 * ignored, since GROBID declares "en" regardless of the document language.
 * @param {Document|null} xmlDoc
 * @returns {string[]}
 */
function getDocumentLanguages(xmlDoc) {
  if (!xmlDoc) return []
  return Array.from(xmlDoc.getElementsByTagNameNS('http://www.tei-c.org/ns/1.0', 'language'))
    .map(el => el.getAttribute('ident'))
    .filter(ident => ident && ident !== 'und')
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

