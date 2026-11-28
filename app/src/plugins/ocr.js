/**
 * Text recognition (OCR) services: lists the OCR engines registered in the backend,
 * checks the quality of the text layer of a PDF, lets the user configure the
 * parameters of an engine and applies OCR to a PDF.
 *
 * The engine parameters chosen in the dialog are remembered per engine.
 *
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { SlDialog, SlSelect, SlInput, SlCheckbox } from '../ui.js'
 * @import { ocrOptionsDialogPart } from '../templates/ocr-dialog.types.js'
 * @import { Job, OcrEngineInfo, OcrOptionInfo, OcrOptionValue, OcrRequest, OcrResponse, TextQualityReport } from '../modules/api-client-v1.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { SlSelect as SlSelectClass, SlOption, SlInput as SlInputClass, SlCheckbox as SlCheckboxClass } from '../ui.js'
import { setLanguageOptions, getSelectedLanguages, matchLanguages } from '../modules/language-chooser.js'
import { testLog } from '../modules/test-log.js'
import { notify } from '../modules/sl-utils.js'
import { describeLlmCorrections } from '../modules/ocr-llm-corrections.js'
import { JobCancelledError, JobFailedError } from '../modules/job-client.js'

await registerTemplate('ocr-dialog', 'ocr-dialog.html')

/** Where the user finds the standalone correction (see ocr-correction.js) */
export const CORRECTION_MENU_PATH = 'Tools > OCR > Correct OCR errors in PDF without review (LLM)'

/**
 * Parameters of an OCR run
 * @typedef {object} OcrSettings
 * @property {string[]} languages - Normalized language codes
 * @property {Record<string, OcrOptionValue>} options - Engine parameters
 * @property {boolean} [llmCorrection] - Correct OCR errors with the default language model after recognition
 */

/**
 * Thrown by {@link OcrPlugin#recognize} when the run was cancelled before its result was stored:
 * the PDF is unchanged
 */
export class OcrCancelledError extends Error {
  constructor() {
    super('Text recognition was cancelled.')
    this.name = 'OcrCancelledError'
  }
}

/**
 * Options of {@link OcrPlugin#recognize}
 * @typedef {object} OcrRecognizeOptions
 * @property {AbortSignal} [signal] - Cancels the job when aborted: the server stops it at the next
 *   progress report. If the OCR result was already stored, only the LLM correction pass stops and
 *   the result has `llm_correction_cancelled`
 */

/**
 * @typedef {object} OcrRunOptions
 * @property {string} engine - Id of the OCR engine
 * @property {string[]} languages - Normalized language codes
 * @property {Record<string, OcrOptionValue>} options - Engine parameters
 * @property {boolean} [llmCorrection] - Correct OCR errors with the default language model after recognition; ignored if no default model is selected
 * @property {boolean} [rebuild] - The user explicitly asked to recreate the text layer, so a digital text layer is replaced even if it looks fine
 */

class OcrPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'ocr', deps: ['client', 'logger', 'inference-settings', 'api-keys', 'jobs'] })
  }

  get #client() { return this.getDependency('client') }

  /** @type {SlDialog & ocrOptionsDialogPart} */
  #dialogUi = null

  /** @type {Promise<OcrEngineInfo[]>|null} */
  #enginesPromise = null

  /** @type {OcrEngineInfo[]|null} The engine list once it is loaded */
  #engines = null

  async install(_state) {
    await super.install(_state)
    const dialog = createSingleFromTemplate('ocr-dialog', document.body)
    this.#dialogUi = this.createUi(dialog)
  }

  /**
   * Load the engine list in the background when a user logs in, so that the extraction dialog
   * can offer text recognition at once.
   * @param {any} newUser
   */
  async onUserChange(newUser) {
    if (!newUser) return
    this.getEngines().catch(error => {
      this.getDependency('logger').warn('Could not load OCR engines: ' + String(error))
    })
  }

  /**
   * Return the available OCR engines. The list is fetched once and cached.
   * @param {boolean} [refresh] - Fetch the list again
   * @returns {Promise<OcrEngineInfo[]>}
   */
  async getEngines(refresh = false) {
    if (refresh || !this.#enginesPromise) {
      if (refresh) this.#engines = null
      this.#enginesPromise = this.#client.apiClient.ocrEngines()
        .then(engines => {
          this.#engines = engines
          return engines
        })
        .catch(error => {
          this.#enginesPromise = null
          throw error
        })
    }
    return await this.#enginesPromise
  }

  /**
   * Return the engine list if it has been loaded, without waiting for it.
   * @returns {OcrEngineInfo[]|null} The engines, or null while the list is not loaded
   */
  getLoadedEngines() {
    return this.#engines
  }

  /**
   * Return the engine the user chose last, or the first available one.
   * @param {OcrEngineInfo[]} engines
   * @returns {string|null}
   */
  getPreferredEngine(engines) {
    const stored = this.uiStorage.get('engine', null)
    if (stored && engines.some(e => e.id === stored)) return stored
    return engines[0]?.id ?? null
  }

  /**
   * Remember the engine the user chose.
   * @param {string} engineId
   */
  setPreferredEngine(engineId) {
    this.uiStorage.set('engine', engineId)
  }

  /**
   * Assess the text layer of a PDF.
   * @param {string} stableId - stable_id of the PDF
   * @param {{layout?: boolean}} [check] - `layout`: also compare the text layer with the words
   *   recognized on sample page images, which finds misplaced or fragmented text (takes a few seconds)
   * @returns {Promise<TextQualityReport>}
   */
  async getTextQuality(stableId, { layout = false } = {}) {
    const report = await this.#client.apiClient.ocrTextQuality(stableId, layout)
    testLog('OCR_TEXT_QUALITY', { stableId, status: report.status, layout, layoutChecked: Boolean(report.layout_checked) })
    return report
  }

  /**
   * Return the default settings for an engine: the options last chosen in the dialog (or the
   * engine defaults), and as language the first suggested language the engine supports. Without
   * a usable suggestion, the languages last chosen in the dialog or the engine's default
   * languages are used.
   * @param {OcrEngineInfo} engine
   * @param {Array<string|null|undefined>} [suggestedLanguages] - Language codes in order of preference, e.g. the document language
   * @returns {OcrSettings}
   */
  getSettings(engine, suggestedLanguages = []) {
    /** @type {Record<string, OcrSettings>} */
    const stored = this.uiStorage.get('settings', {}) || {}
    const saved = stored[engine.id]
    /** @type {Record<string, OcrOptionValue>} */
    const options = {}
    for (const [key, info] of Object.entries(engine.options)) {
      const value = saved?.options?.[key]
      if (value !== undefined && isValidOptionValue(info, value)) {
        options[key] = value
      } else if (info.default !== null && info.default !== undefined) {
        options[key] = info.default
      }
    }
    // suggestions are alternatives in order of preference, not a list of document languages
    let languages = matchLanguages(suggestedLanguages, engine.languages).slice(0, 1)
    if (!languages.length) languages = matchLanguages(saved?.languages ?? [], engine.languages)
    if (!languages.length) languages = [...engine.default_languages]
    return { languages, options, llmCorrection: this.uiStorage.get('llmCorrection', false) === true }
  }

  /**
   * Store the settings for an engine.
   * @param {string} engineId
   * @param {OcrSettings} settings
   */
  saveSettings(engineId, settings) {
    /** @type {Record<string, OcrSettings>} */
    const stored = this.uiStorage.get('settings', {}) || {}
    stored[engineId] = settings
    this.uiStorage.set('settings', stored)
  }

  /**
   * Describe the LLM correction for display in the extraction dialog, if it will be applied to the
   * next run: the user chose it earlier and a default model is selected.
   * @returns {string} The note, or an empty string if the correction is off
   */
  getLlmCorrectionNote() {
    if (this.uiStorage.get('llmCorrection', false) !== true) return ''
    const inference = this.getDependency('inference-settings')
    const model = inference.getDefaultModel()
    if (!model) return ''
    return `LLM correction of OCR errors is on (${inference.getModelLabel(model.providerId, model.modelId)}).`
  }

  /**
   * Show the dialog to configure the parameters of an engine. The result is stored as the
   * default for later runs (see {@link OcrPlugin#getSettings}).
   * @param {OcrEngineInfo} engine
   * @param {OcrSettings} settings - Values to show in the dialog
   * @returns {Promise<OcrSettings|null>} The chosen settings, or null if the user cancelled
   */
  async configure(engine, settings) {
    const dialogUi = this.#dialogUi

    dialogUi.label = `Text recognition options: ${engine.name}`
    dialogUi.engineDescription.textContent = engine.description
    setLanguageOptions(dialogUi.languages, engine.languages, settings.languages)

    const inference = this.getDependency('inference-settings')
    const model = inference.getDefaultModel()
    const llm = dialogUi.llmCorrection
    llm.disabled = !model
    llm.checked = Boolean(model) && settings.llmCorrection === true
    if (model) {
      llm.title = ''
      llm.setAttribute('help-text', `Uses ${inference.getModelLabel(model.providerId, model.modelId)} to correct misread words, mainly footnote numbers, on pages that look poor. Changes the text without review; every correction is listed afterwards. Costs about one LLM call per two such pages.`)
    } else {
      llm.title = 'Select a default model in Tools > Inference first.'
      llm.setAttribute('help-text', 'Select a default model in Tools > Inference first.')
    }

    const optionsContainer = dialogUi.engineOptions
    optionsContainer.innerHTML = ''
    /** @type {Array<{key: string, info: OcrOptionInfo, element: SlSelect|SlInput|SlCheckbox}>} */
    const fields = []
    for (const [key, info] of Object.entries(engine.options)) {
      const element = createOptionField(key, info, settings.options[key])
      optionsContainer.append(element)
      fields.push({ key, info, element })
    }

    dialogUi.show()
    testLog('OCR_DIALOG_OPENED', { engine: engine.id, languages: settings.languages })

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const confirmed = await new Promise(resolve => {
          const controller = new AbortController()
          const done = (/** @type {boolean} */ value) => { controller.abort(); resolve(value) }
          dialogUi.addEventListener('sl-request-close', () => done(false), { signal: controller.signal })
          dialogUi.cancel.addEventListener('click', () => done(false), { signal: controller.signal })
          dialogUi.submit.addEventListener('click', () => done(true), { signal: controller.signal })
        })
        if (!confirmed) return null

        const languages = getSelectedLanguages(dialogUi.languages)
        if (!languages.length) {
          dialogUi.languages.setCustomValidity('Select at least one language')
          dialogUi.languages.reportValidity()
          continue
        }
        dialogUi.languages.setCustomValidity('')

        /** @type {Record<string, OcrOptionValue>} */
        const options = {}
        for (const { key, info, element } of fields) {
          options[key] = readOptionField(info, element)
        }
        const llmCorrection = !llm.disabled && llm.checked
        if (!llm.disabled) this.uiStorage.set('llmCorrection', llmCorrection)
        const result = { languages, options, llmCorrection }
        this.saveSettings(engine.id, { languages, options })
        testLog('OCR_OPTIONS_SAVED', { engine: engine.id, ...result })
        return result
      }
    } finally {
      dialogUi.hide()
    }
  }

  /**
   * Apply OCR to a PDF; the result is stored as a new PDF of the document (#944).
   *
   * The server runs OCR as a job (type `ocr`), since a long document can take longer than a
   * reverse proxy waits for a response. The `jobs` plugin shows its progress widget, whose cancel
   * button cancels it. Only one OCR run happens at a time on the server, so the job may first wait
   * in the queue.
   *
   * The OCR result is stored before the optional LLM correction pass starts, so that it is kept if
   * the pass fails or is cancelled (then the result has `llm_correction_cancelled`).
   * @param {string} stableId - stable_id of the PDF
   * @param {OcrRunOptions} run - Engine and parameters
   * @param {OcrRecognizeOptions} [recognizeOptions]
   * @returns {Promise<OcrResponse>}
   * @throws {OcrCancelledError} If the run was cancelled before the OCR result was stored
   * @throws {Error} An ApiError (invalid request, or 409 if a job already holds the PDF) or
   *   ServerError (failure of the engine or the server) if the run fails
   */
  async recognize(stableId, run, { signal } = {}) {
    this.getDependency('logger').info(`Applying OCR (${run.engine}, ${run.languages.join(', ')}) to ${stableId}`)
    const client = this.#client
    const request = this.createRequest(stableId, run)
    const result = await this.#runJob(stableId, () => client.apiClient.ocr(request), signal)
    this.reportResult(stableId, result, Boolean(request.llm_correction))
    return result
  }

  /**
   * The request of an OCR run, as `POST /api/v1/ocr` and the `ocr` step of an extraction job take
   * it. With `run.llmCorrection`, the correction pass uses the default language model, if one is selected.
   * @param {string} stableId - stable_id of the PDF
   * @param {OcrRunOptions} run - Engine and parameters
   * @returns {OcrRequest}
   */
  createRequest(stableId, run) {
    const model = run.llmCorrection ? this.getDependency('inference-settings').getDefaultModel() : null
    return {
      stable_id: stableId,
      engine: run.engine,
      languages: run.languages,
      options: run.options,
      rebuild: Boolean(run.rebuild),
      ...(model ? { llm_correction: true, provider_id: model.providerId, model_id: model.modelId } : {})
    }
  }

  /**
   * Log the result of a finished OCR run and tell the user what its LLM correction pass did; also
   * for the OCR step of an extraction job.
   * @param {string} stableId - stable_id of the PDF the run started from
   * @param {OcrResponse} result
   * @param {boolean} correctionRequested - Whether the LLM correction was requested
   */
  reportResult(stableId, result, correctionRequested) {
    testLog('OCR_COMPLETED', { stableId, changed: result.changed, status: result.quality.status, method: result.method ?? null })
    this.#reportCorrections(result, correctionRequested)
  }

  /**
   * Correct the OCR errors of the text layer of a stored PDF with the default language model, e.g.
   * after the correction pass of a text recognition run was cancelled. The result is stored as a
   * new PDF of the document if anything was corrected. Runs as a job (type `ocr.llm-correction`)
   * like {@link recognize}.
   * @param {string} stableId - stable_id of the PDF
   * @param {OcrRecognizeOptions} [options]
   * @returns {Promise<OcrResponse>}
   * @throws {OcrCancelledError} If the run was cancelled: the PDF is unchanged
   * @throws {Error} If no default model is selected, the request is invalid (409 if a job already
   *   holds the PDF) or the run fails
   */
  async correct(stableId, { signal } = {}) {
    const model = this.getDependency('inference-settings').getDefaultModel()
    if (!model) {
      throw new Error('No default model configured. Set one via Tools > Inference > Default Model.')
    }
    this.getDependency('logger').info(`Correcting the OCR errors of ${stableId} with ${model.providerId}/${model.modelId}`)
    const client = this.#client
    const result = await this.#runJob(stableId, () => client.apiClient.ocrLlmCorrection({
      stable_id: stableId,
      provider_id: model.providerId,
      model_id: model.modelId
    }), signal)
    testLog('OCR_CORRECTION_COMPLETED', { stableId, changed: result.changed, corrections: (result.llm_corrections ?? []).length })
    this.#reportCorrections(result, true)
    return result
  }

  /**
   * Submit an OCR job through its route and wait until it is finished. The `jobs` plugin shows
   * the job's progress widget.
   * @param {string} stableId - stable_id of the PDF
   * @param {() => Promise<Job>} submit - Submits the job
   * @param {AbortSignal} [signal] - Cancels the job when aborted
   * @returns {Promise<OcrResponse>} The result of the job
   * @throws {OcrCancelledError} If the job was cancelled
   * @throws {Error} An ApiError or ServerError if the job could not be submitted or failed
   */
  async #runJob(stableId, submit, signal) {
    const logger = this.getDependency('logger')
    const client = this.#client
    const jobs = this.getDependency('jobs')
    // 428 if the provider of the model needs an API key of the user: ask for it and submit again
    const job = await this.getDependency('api-keys').withKeyPrompt(submit)
    const waiting = jobs.wait(job.id)
    testLog('OCR_JOB_SUBMITTED', { stableId, jobId: job.id, type: job.type })
    const requestCancel = () => {
      testLog('OCR_CANCEL_REQUESTED', { stableId, jobId: job.id })
      jobs.cancel(job.id).catch(error => logger.warn(`Could not cancel OCR job ${job.id}: ${String(error)}`))
    }
    if (signal?.aborted) requestCancel()
    signal?.addEventListener('abort', requestCancel, { once: true })
    try {
      return /** @type {OcrResponse} */ (await waiting)
    } catch (error) {
      if (error instanceof JobCancelledError) {
        testLog('OCR_CANCELLED', { stableId })
        throw new OcrCancelledError()
      }
      if (error instanceof JobFailedError) {
        testLog('OCR_FAILED', { stableId, error: error.message, status: error.status })
        throw error.status < 500 ? new client.ApiError(error.message, error.status) : new client.ServerError(error.message, error.status)
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', requestCancel)
    }
  }

  /**
   * Tell the user what the LLM correction pass of a finished job did.
   * @param {OcrResponse} result
   * @param {boolean} requested - Whether the correction was requested
   */
  #reportCorrections(result, requested) {
    const corrections = result.llm_corrections ?? []
    const error = result.llm_correction_error ?? null
    testLog('OCR_LLM_CORRECTION', { requested, corrections: corrections.length, error, cancelled: Boolean(result.llm_correction_cancelled) })
    if (corrections.length) {
      notify(describeLlmCorrections(corrections), 'primary', 'info-circle', 15000)
    }
    if (result.llm_correction_cancelled) {
      notify(`The correction with a language model was cancelled. The result of the text recognition was kept. To run the correction again, choose ${CORRECTION_MENU_PATH}.`, 'primary', 'info-circle', 10000)
    } else if (error) {
      notify(`The correction with a language model did not finish: ${error}`, 'warning', 'exclamation-triangle', 10000)
    } else if (requested && !corrections.length && result.message) {
      // Why nothing was corrected, e.g. "No OCR errors found on 3 reviewed pages."
      notify(result.message, 'primary', 'info-circle', 10000)
    }
  }
}

/**
 * Return whether a stored value is still valid for an option.
 * @param {OcrOptionInfo} info
 * @param {OcrOptionValue} value
 * @returns {boolean}
 */
function isValidOptionValue(info, value) {
  switch (info.type) {
    case 'boolean': return typeof value === 'boolean'
    case 'integer': return Number.isInteger(value)
    default: return typeof value === 'string' && (!info.options || info.options.includes(value))
  }
}

/**
 * Create a form field for an engine option.
 * @param {string} key
 * @param {OcrOptionInfo} info
 * @param {OcrOptionValue|undefined} value
 * @returns {SlSelect|SlInput|SlCheckbox}
 */
function createOptionField(key, info, value) {
  const label = info.label || key
  if (info.type === 'boolean') {
    const checkbox = Object.assign(new SlCheckboxClass(), { name: key, size: 'small', checked: value === true, textContent: label })
    if (info.description) checkbox.setAttribute('help-text', info.description)
    return checkbox
  }
  if (info.type === 'string' && info.options?.length) {
    const select = Object.assign(new SlSelectClass(), { name: key, label, size: 'small' })
    if (info.description) select.setAttribute('help-text', info.description)
    for (const option of info.options) {
      select.append(Object.assign(new SlOption(), { value: option, textContent: option }))
    }
    requestAnimationFrame(() => { select.value = String(value ?? info.options[0]) })
    return select
  }
  const input = Object.assign(new SlInputClass(), {
    name: key,
    label,
    size: 'small',
    type: info.type === 'integer' ? 'number' : 'text',
    value: value === undefined || value === null ? '' : String(value)
  })
  if (info.description) input.setAttribute('help-text', info.description)
  return input
}

/**
 * Read the value of a field created by {@link createOptionField}.
 * @param {OcrOptionInfo} info
 * @param {SlSelect|SlInput|SlCheckbox} element
 * @returns {OcrOptionValue}
 */
function readOptionField(info, element) {
  if (info.type === 'boolean') return /** @type {SlCheckbox} */(element).checked
  const value = String(/** @type {SlSelect|SlInput} */(element).value ?? '')
  if (info.type === 'integer') {
    const number = parseInt(value, 10)
    return Number.isNaN(number) ? Number(info.default ?? 0) : number
  }
  return value
}

export default OcrPlugin

export const plugin = OcrPlugin
