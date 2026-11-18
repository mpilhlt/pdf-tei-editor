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
 * @import { OcrEngineInfo, OcrOptionInfo, OcrOptionValue, OcrResponse, TextQualityReport } from '../modules/api-client-v1.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { SlSelect as SlSelectClass, SlOption, SlInput as SlInputClass, SlCheckbox as SlCheckboxClass } from '../ui.js'
import { setLanguageOptions, getSelectedLanguages, matchLanguages } from '../modules/language-chooser.js'
import { testLog } from '../modules/test-log.js'

await registerTemplate('ocr-dialog', 'ocr-dialog.html')

/**
 * Parameters of an OCR run
 * @typedef {object} OcrSettings
 * @property {string[]} languages - Normalized language codes
 * @property {Record<string, OcrOptionValue>} options - Engine parameters
 */

/**
 * @typedef {object} OcrRunOptions
 * @property {string} engine - Id of the OCR engine
 * @property {string[]} languages - Normalized language codes
 * @property {Record<string, OcrOptionValue>} options - Engine parameters
 */

class OcrPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'ocr', deps: ['client', 'logger'] })
  }

  get #client() { return this.getDependency('client') }

  /** @type {SlDialog & ocrOptionsDialogPart} */
  #dialogUi = null

  /** @type {Promise<OcrEngineInfo[]>|null} */
  #enginesPromise = null

  async install(_state) {
    await super.install(_state)
    const dialog = createSingleFromTemplate('ocr-dialog', document.body)
    this.#dialogUi = this.createUi(dialog)
  }

  /**
   * Return the available OCR engines. The list is fetched once and cached.
   * @param {boolean} [refresh] - Fetch the list again
   * @returns {Promise<OcrEngineInfo[]>}
   */
  async getEngines(refresh = false) {
    if (refresh || !this.#enginesPromise) {
      this.#enginesPromise = this.#client.apiClient.ocrEngines().catch(error => {
        this.#enginesPromise = null
        throw error
      })
    }
    return await this.#enginesPromise
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
   * @returns {Promise<TextQualityReport>}
   */
  async getTextQuality(stableId) {
    const report = await this.#client.apiClient.ocrTextQuality(stableId)
    testLog('OCR_TEXT_QUALITY', { stableId, status: report.status })
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
    return { languages, options }
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
        const result = { languages, options }
        this.saveSettings(engine.id, result)
        testLog('OCR_OPTIONS_SAVED', { engine: engine.id, ...result })
        return result
      }
    } finally {
      dialogUi.hide()
    }
  }

  /**
   * Apply OCR to a PDF. The stored PDF is replaced; its stable_id stays the same.
   * @param {string} stableId - stable_id of the PDF
   * @param {OcrRunOptions} run - Engine and parameters
   * @returns {Promise<OcrResponse>}
   */
  async recognize(stableId, run) {
    this.getDependency('logger').info(`Applying OCR (${run.engine}, ${run.languages.join(', ')}) to ${stableId}`)
    const result = await this.#client.apiClient.ocr({
      stable_id: stableId,
      engine: run.engine,
      languages: run.languages,
      options: run.options
    })
    testLog('OCR_COMPLETED', { stableId, changed: result.changed, status: result.quality.status })
    return result
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
