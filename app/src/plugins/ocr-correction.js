/**
 * Tools action "Correct OCR errors in PDF (LLM)": lets the default language model correct the OCR
 * errors of the text layer of the open PDF, without running text recognition again. This is the
 * correction pass of text recognition on its own, e.g. to run it again after it was cancelled.
 *
 * The run happens in the background with a cancellable progress widget. Cancelling leaves the PDF
 * unchanged. When it is finished, the corrected PDF is loaded if the user still has the same
 * documents open; otherwise the user is asked first.
 *
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { SlMenuItem } from '../ui.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { notify } from '../modules/sl-utils.js'
import { testLog } from '../modules/test-log.js'
import { loadWhenFinished } from '../modules/background-result.js'
import { OcrCancelledError } from './ocr.js'

/** Shown as tooltip of the menu item when no PDF is open */
const NO_PDF_MESSAGE = 'Requires an open PDF.'

/**
 * Escape text for use in the dialog's HTML message.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

class OcrCorrectionPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'ocr-correction', deps: ['tools', 'ocr', 'progress', 'dialog', 'services', 'file-selection', 'inference-settings'] })
  }

  /** @type {SlMenuItem|null} */
  #menuItem = null

  /** stable_ids of the PDFs being corrected */
  #running = new Set()

  async start() {
    const item = /** @type {SlMenuItem} */ (document.createElement('sl-menu-item'))
    item.textContent = 'Correct OCR errors in PDF (LLM)'
    item.addEventListener('click', () => {
      this.run().catch(error => this.#fail(error))
    })
    this.#menuItem = item
    this.getDependency('tools').addMenuItems([item], 'ocr')
    this.#updateMenuItem()
  }

  onPdfChange() {
    this.#updateMenuItem()
  }

  /** Enable the menu item when a PDF is open. */
  #updateMenuItem() {
    if (!this.#menuItem) return
    const enabled = Boolean(this.state?.pdf)
    this.#menuItem.disabled = !enabled
    this.#menuItem.title = enabled ? '' : NO_PDF_MESSAGE
  }

  /**
   * Confirm with the model's name, then correct the OCR errors of the open PDF in the background.
   * @returns {Promise<void>}
   */
  async run() {
    const stableId = this.state?.pdf
    if (!stableId) return
    if (this.#running.has(stableId)) {
      notify('The OCR errors of this PDF are already being corrected.', 'primary', 'info-circle')
      return
    }
    const inferenceSettings = this.getDependency('inference-settings')
    const model = inferenceSettings.getDefaultModel()
    if (!model) {
      notify('No default model configured. Set one via Tools > Inference > Default Model.', 'warning', 'exclamation-triangle')
      return
    }
    const label = inferenceSettings.getModelLabel(model.providerId, model.modelId)
    const confirmed = await this.getDependency('dialog').confirm(
      `Correct the OCR errors in the text layer of the PDF using ${escapeHtml(label)}? The text of the pages that look poor is sent to the model, and the corrections are written into the PDF without a review.`,
      'Correct OCR errors'
    )
    if (!confirmed) return

    const started = { pdf: this.state.pdf, xml: this.state.xml }
    const progress = this.getDependency('progress')
    const progressId = `ocr-correction-${stableId}`
    const controller = new AbortController()
    this.#running.add(stableId)
    progress.show(progressId, {
      label: `Correcting OCR errors using ${label}…`,
      value: null,
      cancellable: true,
      onCancel: () => controller.abort()
    })
    let result
    try {
      result = await this.getDependency('ocr').correct(stableId, {
        signal: controller.signal,
        onStatus: (_status, message, job) => {
          progress.setLabel(progressId, message)
          const total = job.progress?.total
          progress.setValue(progressId, total ? Math.min(100, Math.round(((job.progress?.done ?? 0) / total) * 100)) : null)
        }
      })
    } catch (error) {
      if (error instanceof OcrCancelledError) {
        notify('The correction was cancelled. The PDF is unchanged.', 'primary', 'info-circle')
        return
      }
      throw error
    } finally {
      this.#running.delete(stableId)
      progress.hide(progressId)
    }
    if (!result.changed) return
    await loadWhenFinished({
      started,
      current: { pdf: this.state.pdf, xml: this.state.xml },
      finishedMessage: 'The correction of the OCR errors is finished.',
      confirm: message => this.getDependency('dialog').confirm(message, 'Finished'),
      refreshFileList: () => this.getDependency('file-selection').reload({ refresh: true }),
      // the corrected PDF keeps its stable_id: load it again, with the document that was open
      load: () => this.getDependency('services').load({ pdf: stableId, xml: started.pdf === stableId ? started.xml : null })
    })
  }

  /**
   * Show an error of the run.
   * @param {any} error
   */
  #fail(error) {
    const message = error?.message ?? String(error)
    notify(`Correcting OCR errors failed: ${message}`, 'danger', 'exclamation-octagon', 10000)
    testLog('OCR_CORRECTION_FAILED', { message })
  }
}

export default OcrCorrectionPlugin
export { OcrCorrectionPlugin }
