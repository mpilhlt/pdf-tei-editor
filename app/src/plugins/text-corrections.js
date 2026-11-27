/**
 * Tools action "Write text corrections to PDF": shows the corrections a reviewer made in the TEI
 * document compared with the OCR text layer of the PDF and writes them into the text layer through
 * the backend, which saves the updated TEI as a new version based on the corrected PDF. The new
 * version and the corrected PDF are then loaded.
 *
 * {@link TextCorrectionsPlugin#writePages} writes only the corrections on some pages (the focus
 * action "Write text corrections to PDF" of the OCR review, see ocr-review.js): the open version is
 * attached to the corrected PDF instead of a new version being created, the backend records the
 * write in its revision history, and the editor and the viewer are updated in place. The dialog is
 * only shown if some changes cannot be written.
 *
 * Each step is shown in a progress widget; the backend reports its steps and the pages it has done
 * to that widget via SSE (`progress_id` of the requests). The cancel button of the widget cancels
 * the preview or the write on the backend (`POST /api/v1/ocr/text-corrections/cancel/{progress_id}`),
 * which then stops at its next page or step without changing the PDF or the document. A write
 * that has already stored its result finishes as usual.
 *
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { SlDialog, SlMenuItem } from '../ui.js'
 * @import { textCorrectionsDialogPart } from '../templates/text-corrections-dialog.types.js'
 * @import { TextCorrectionsPreview, TextCorrectionsResult } from '../modules/api-client-v1.js'
 * @import { UserData } from './authentication.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { notify } from '../modules/sl-utils.js'
import { testLog } from '../modules/test-log.js'
import { userHasReviewerRole } from '../modules/acl-utils.js'
import { summarizePreview } from '../modules/text-corrections.js'

export { summarizePreview }

await registerTemplate('text-corrections-dialog', 'text-corrections-dialog.html')
await registerTemplate('text-corrections-menu-item', 'text-corrections-menu-item.html')

/** Shown when the action is chosen while it runs */
const BUSY_MESSAGE = 'Text corrections are being written to the PDF. Please wait until this is finished.'

/** Shown when the document is open read-only */
const READ_ONLY_MESSAGE = 'The document is open read-only (it is edited in another session, or you cannot edit it). Text corrections can only be written from a document you are editing.'

/** Note of the dialog when the whole document is written */
const VERSION_NOTE = 'The corrections are written into a copy of the PDF, which the new version is attached to. This version and its PDF are not changed.'

/** Note of the dialog when the corrections of some pages are written */
const PAGES_NOTE = 'The corrections are written into a copy of the PDF, which this version is then attached to. Other versions keep their PDF.'

/** Title of the progress widgets */
const PROGRESS_TITLE = 'Writing text corrections to PDF'

/** Shown when the user cancelled the preview or the write */
const CANCELLED_MESSAGE = 'Writing the text corrections was cancelled. The PDF and the document are unchanged.'

/** Shown when the user cancelled a write that had already stored its result */
const TOO_LATE_MESSAGE = 'The corrections had already been saved when you cancelled, so they were written.'

/**
 * Whether an error of a preview or write request says that the user cancelled it.
 * @param {any} error
 * @returns {boolean}
 */
function isCancelledError(error) {
  return error?.statusCode === 409 && error?.detail?.code === 'cancelled'
}

/** Shown when the editor content could not be saved */
const UNSAVED_MESSAGE = 'The document has changes that could not be saved, for example because the XML is not well-formed. Fix and save the document before writing text corrections.'

class TextCorrectionsPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'text-corrections', deps: ['client', 'tools', 'progress'] })
  }

  get #client() { return this.getDependency('client') }

  get #progress() { return this.getDependency('progress') }

  /** @type {SlDialog & textCorrectionsDialogPart} */
  #dialogUi = null

  /** @type {SlMenuItem} */
  #menuItem = null

  /** True while a preview or write request runs */
  #busy = false

  async install(state) {
    await super.install(state)
    this.#dialogUi = this.createUi(createSingleFromTemplate('text-corrections-dialog', document.body))
  }

  async start() {
    this.#menuItem = /** @type {SlMenuItem} */ (createSingleFromTemplate('text-corrections-menu-item'))
    this.#menuItem.addEventListener('click', () => {
      this.run().catch(error => this.#fail(error))
    })
    this.getDependency('tools').addMenuItems([this.#menuItem], 'ocr')
    this.#updateMenuItem()
  }

  /** @param {UserData|null} _newUser */
  onUserChange(_newUser) {
    this.#updateMenuItem()
  }

  onXmlChange() {
    this.#updateMenuItem()
  }

  /** Show the item for reviewers, enable it when a TEI document is open. */
  #updateMenuItem() {
    if (!this.#menuItem) return
    this.#menuItem.style.display = userHasReviewerRole(this.state?.user ?? null) ? '' : 'none'
    this.#menuItem.disabled = !this.state?.xml
  }

  /**
   * Preview the corrections of the open document and, after confirmation, write them and load the
   * new version.
   * @returns {Promise<void>}
   */
  async run() {
    const stableId = this.state.xml
    if (!stableId) return
    if (this.#busy) {
      notify(BUSY_MESSAGE, 'primary', 'info-circle')
      return
    }
    if (this.state.editorReadOnly) {
      notify(READ_ONLY_MESSAGE, 'warning', 'lock')
      testLog('TEXT_CORRECTIONS_REFUSED', { reason: 'read-only' })
      return
    }
    this.#busy = true
    try {
      const preview = await this.#preview(stableId)
      if (!preview) return
      testLog('TEXT_CORRECTIONS_PREVIEW', {
        corrections: preview.corrections.length,
        unwritable: preview.unwritable.length,
        reason: preview.reason ?? null
      })
      const result = await this.#showDialog(preview, stableId)
      if (result) await this.#loadResult(result)
    } finally {
      this.#busy = false
    }
  }

  /**
   * Write the corrections on the given pages of the open document into the PDF, without creating
   * a new version: the open version is attached to the corrected PDF, which the viewer then shows.
   * Writes without asking unless some changes cannot be written; then the dialog asks to skip them.
   * @param {number[]} pages - 0-based page indices of the PDF
   * @returns {Promise<'written'|'nothing'|'failed'>} 'nothing' if there is nothing to write on
   *   these pages, 'failed' if the corrections were not written for another reason (including
   *   that the user cancelled)
   */
  async writePages(pages) {
    const stableId = this.state.xml
    if (!stableId) return 'failed'
    if (this.#busy) {
      notify(BUSY_MESSAGE, 'primary', 'info-circle')
      return 'failed'
    }
    if (this.state.editorReadOnly) {
      notify(READ_ONLY_MESSAGE, 'warning', 'lock')
      testLog('TEXT_CORRECTIONS_REFUSED', { reason: 'read-only' })
      return 'failed'
    }
    this.#busy = true
    try {
      const preview = await this.#preview(stableId, pages)
      if (!preview) return 'failed'
      testLog('TEXT_CORRECTIONS_PREVIEW', {
        corrections: preview.corrections.length,
        unwritable: preview.unwritable.length,
        reason: preview.reason ?? null,
        pages
      })
      /** @type {TextCorrectionsResult|null} */
      let result
      if (preview.reason) {
        notify(summarizePreview(preview).text, 'warning', 'exclamation-triangle')
        return 'nothing'
      } else if (preview.unwritable.length) {
        result = await this.#showDialog(preview, stableId, pages)
      } else {
        result = await this.#write(stableId, false, pages)
      }
      if (!result) return 'failed'
      await this.#loadResult(result)
      return 'written'
    } finally {
      this.#busy = false
    }
  }

  /**
   * Show a progress widget whose cancel button cancels the request that reports to it.
   * @param {string} progressId
   * @param {string} label
   * @returns {{cancelled: boolean}} `cancelled` becomes true when the user clicks the cancel button
   */
  #showProgress(progressId, label) {
    const run = { cancelled: false }
    this.#progress.show(progressId, {
      title: PROGRESS_TITLE,
      label,
      value: null,
      cancellable: true,
      onCancel: () => {
        run.cancelled = true
        testLog('TEXT_CORRECTIONS_CANCEL_REQUESTED', { progressId })
        this.#client.apiClient.ocrTextCorrectionsCancel(progressId).catch(error => {
          this.getDependency('logger').warn(`Could not cancel writing the text corrections: ${error}`)
        })
      }
    })
    return run
  }

  /** Tell the user that the preview or the write was cancelled. */
  #notifyCancelled() {
    notify(CANCELLED_MESSAGE, 'primary', 'info-circle')
    testLog('TEXT_CORRECTIONS_CANCELLED', {})
  }

  /**
   * Write the corrections, showing the steps in a progress widget whose cancel button cancels the
   * write.
   * @param {string} stableId
   * @param {boolean} skipUnwritable
   * @param {number[]|null} pages - Only the corrections on these pages; null for the whole document
   * @returns {Promise<TextCorrectionsResult|null>} The result, or null if the user cancelled the write
   */
  async #write(stableId, skipUnwritable, pages) {
    const progressId = `text-corrections-write-${stableId}`
    testLog('TEXT_CORRECTIONS_WRITING', { stableId, pages })
    // the backend shows its steps in the widget
    const run = this.#showProgress(progressId, 'Writing the corrections to the PDF…')
    try {
      const result = await this.#client.apiClient.ocrTextCorrectionsApply({ stable_id: stableId, skip_unwritable: skipUnwritable, progress_id: progressId, pages })
      // the backend had stored the result before it saw the cancel request
      if (run.cancelled) notify(TOO_LATE_MESSAGE, 'primary', 'info-circle')
      return result
    } catch (error) {
      if (isCancelledError(error)) {
        this.#notifyCancelled()
        return null
      }
      throw error
    } finally {
      this.#progress.hide(progressId)
    }
  }

  /**
   * Save the document and find the corrections that can be written, showing the steps in a
   * progress widget.
   * @param {string} stableId
   * @param {number[]|null} [pages] - Only the corrections on these pages; null for the whole document
   * @returns {Promise<TextCorrectionsPreview|null>} The preview, or null if the document could not
   *   be saved or the user cancelled
   */
  async #preview(stableId, pages = null) {
    const progressId = `text-corrections-preview-${stableId}`
    const run = this.#showProgress(progressId, 'Saving the document…')
    testLog('TEXT_CORRECTIONS_PROGRESS', { step: 'preview' })
    try {
      const xmlEditor = this.getDependency('xmleditor')
      await xmlEditor.saveIfDirty()
      // the preview and the write use the stored document: refuse if the editor content is not it
      if (xmlEditor.isDirty() || !xmlEditor.getXmlTree()) {
        notify(UNSAVED_MESSAGE, 'warning', 'exclamation-triangle')
        testLog('TEXT_CORRECTIONS_REFUSED', { reason: 'unsaved' })
        return null
      }
      if (run.cancelled) {
        this.#notifyCancelled()
        return null
      }
      // the backend shows its steps in the widget
      this.#progress.setLabel(progressId, 'Comparing the document with the text layer of the PDF…')
      const preview = await this.#client.apiClient.ocrTextCorrectionsPreview({ stable_id: stableId, progress_id: progressId, pages })
      // the preview changes nothing: drop it if it finished before the backend saw the cancel request
      if (run.cancelled) {
        this.#notifyCancelled()
        return null
      }
      return preview
    } catch (error) {
      if (isCancelledError(error)) {
        this.#notifyCancelled()
        return null
      }
      throw error
    } finally {
      this.#progress.hide(progressId)
    }
  }

  /**
   * Fill and show the dialog. When the user confirms, the corrections are written while the dialog
   * stays open with the Write button in loading state, and the steps are shown in a progress widget.
   * @param {TextCorrectionsPreview} preview
   * @param {string} stableId
   * @param {number[]|null} [pages] - Only the corrections on these pages; null for the whole document
   * @returns {Promise<TextCorrectionsResult|null>} The result of writing, or null if the user did
   *   not confirm or cancelled the write
   * @throws {Error} If writing failed
   */
  async #showDialog(preview, stableId, pages = null) {
    const dlg = this.#dialogUi
    const summary = summarizePreview(preview)
    dlg.summary.textContent = summary.text
    fillList(dlg.correctionsSection.corrections, preview.corrections.map(c => `Page ${c.page + 1} · ${c.old} → ${c.new}`))
    dlg.correctionsSection.style.display = preview.corrections.length ? '' : 'none'
    fillList(dlg.unwritableSection.unwritable, preview.unwritable.map(u => {
      const tei = u.tei_text ? ` → ${u.tei_text}` : ''
      return `Page ${u.page + 1} · ${u.layer_text}${tei} (${u.reason})`
    }))
    dlg.unwritableSection.style.display = preview.unwritable.length ? '' : 'none'
    dlg.unwritableSection.skipUnwritable.checked = false
    dlg.unwritableSection.skipUnwritable.disabled = false
    dlg.unwritableSection.skipUnwritable.style.display = summary.needsSkip ? '' : 'none'
    dlg.write.style.display = summary.canApply ? '' : 'none'
    dlg.write.disabled = summary.needsSkip
    dlg.write.loading = false
    dlg.close.disabled = false
    dlg.versionNote.textContent = pages ? PAGES_NOTE : VERSION_NOTE

    const skipBox = dlg.unwritableSection.skipUnwritable
    const onSkipChange = () => { dlg.write.disabled = !skipBox.checked }
    skipBox.addEventListener('sl-change', onSkipChange)
    dlg.show()
    testLog('TEXT_CORRECTIONS_DIALOG_OPENED', { stableId, canApply: summary.canApply, needsSkip: summary.needsSkip })
    const controller = new AbortController()
    try {
      return await new Promise((resolve, reject) => {
        let writing = false
        dlg.addEventListener('sl-request-close', event => {
          // the dialog stays open until the corrections are written
          if (writing) event.preventDefault()
          else resolve(null)
        }, { signal: controller.signal })
        dlg.close.addEventListener('click', () => { if (!writing) resolve(null) }, { signal: controller.signal })
        dlg.write.addEventListener('click', () => {
          if (writing || dlg.write.disabled) return
          writing = true
          dlg.write.loading = true
          dlg.close.disabled = true
          skipBox.disabled = true
          dlg.summary.textContent = pages
            ? 'Writing the corrections to the PDF.'
            : 'Writing the corrections to the PDF and updating the document. This can take a minute.'
          this.#write(stableId, skipBox.checked, pages).then(resolve, reject)
        }, { signal: controller.signal })
      })
    } finally {
      controller.abort()
      skipBox.removeEventListener('sl-change', onSkipChange)
      dlg.write.loading = false
      dlg.close.disabled = false
      dlg.hide()
    }
  }

  /**
   * Load the new version created by the backend, with the corrected PDF.
   * @param {TextCorrectionsResult} result
   * @returns {Promise<void>}
   */
  async #loadResult(result) {
    if (result.new_version === false) {
      await this.#loadPageResult(result)
      return
    }
    const progressId = `text-corrections-load-${result.tei_stable_id}`
    this.#progress.show(progressId, { title: PROGRESS_TITLE, label: 'Loading the new version and the corrected PDF…', value: null, cancellable: false })
    try {
      await this.getDependency('file-selection').reload({ refresh: true })
      // passing the PDF reloads it in the viewer, although its stable_id did not change
      await this.getDependency('services').load({ pdf: result.pdf_stable_id, xml: result.tei_stable_id })
      notify('Corrections written to the PDF. You are now editing a new version based on the corrected PDF.', 'success', 'check-circle')
      testLog('TEXT_CORRECTIONS_APPLIED', { newFileId: result.tei_stable_id, pdf: result.pdf_stable_id, corrections: result.corrections })
    } catch (error) {
      const reason = /** @type {Error} */ (error)?.message ?? String(error)
      notify(`The corrections were written to the PDF and a new version based on the corrected PDF was created, but it could not be opened (${reason}). Open the newest version of the document from the file selection.`, 'danger', 'exclamation-octagon', 15000)
      testLog('TEXT_CORRECTIONS_FAILED', { message: reason, afterApply: true })
    } finally {
      this.#progress.hide(progressId)
    }
  }

  /**
   * Show the version updated by writing the corrections of some pages, which is still the open
   * one, and the corrected PDF it is now attached to.
   * @param {TextCorrectionsResult} result
   * @returns {Promise<void>}
   */
  async #loadPageResult(result) {
    const progressId = `text-corrections-load-${result.tei_stable_id}`
    this.#progress.show(progressId, { title: PROGRESS_TITLE, label: 'Loading the corrected PDF…', value: null, cancellable: false })
    try {
      const xmlEditor = this.getDependency('xmleditor')
      // the editor keeps its position and folds; if the changes cannot be applied, the version is loaded again
      const applied = this.state.xml === result.tei_stable_id && await xmlEditor.applyRemoteContent(result.xml)
      await this.getDependency('file-selection').reload({ refresh: true })
      const services = this.getDependency('services')
      if (applied) {
        xmlEditor.markAsClean()
        await services.showPdf(result.pdf_stable_id)
      } else {
        await services.load({ pdf: result.pdf_stable_id, xml: result.tei_stable_id })
      }
      notify(`${result.corrections} correction${result.corrections === 1 ? '' : 's'} written to the PDF.`, 'success', 'check-circle')
      testLog('TEXT_CORRECTIONS_APPLIED', { newFileId: result.tei_stable_id, pdf: result.pdf_stable_id, corrections: result.corrections, newVersion: false })
    } catch (error) {
      const reason = /** @type {Error} */ (error)?.message ?? String(error)
      notify(`The corrections were written to the PDF, but the corrected PDF could not be shown (${reason}). Open the document again from the file selection.`, 'danger', 'exclamation-octagon', 15000)
      testLog('TEXT_CORRECTIONS_FAILED', { message: reason, afterApply: true })
    } finally {
      this.#progress.hide(progressId)
    }
  }

  /**
   * Show an error of a request, with the line numbers of a feature-file mismatch (422).
   * @param {any} error
   */
  #fail(error) {
    const lines = error?.detail?.lines
    let message = error?.message ?? String(error)
    if (Array.isArray(lines) && lines.length) message += ` (lines: ${lines.join(', ')})`
    notify(message, 'danger', 'exclamation-octagon', 10000)
    testLog('TEXT_CORRECTIONS_FAILED', { message })
  }
}

/**
 * Replace the items of a list.
 * @param {HTMLElement} list
 * @param {string[]} texts
 */
function fillList(list, texts) {
  list.replaceChildren(...texts.map(text => {
    const li = document.createElement('li')
    li.textContent = text
    return li
  }))
}

export default TextCorrectionsPlugin
export { TextCorrectionsPlugin }
