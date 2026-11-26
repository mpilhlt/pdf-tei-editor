/**
 * Tools action "Write text corrections to PDF": shows the corrections a reviewer made in the TEI
 * document compared with the OCR text layer of the PDF and writes them into the text layer through
 * the backend, which saves the updated TEI as a new version based on the corrected PDF. The new
 * version and the corrected PDF are then loaded.
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

/** Shown when the editor content could not be saved */
const UNSAVED_MESSAGE = 'The document has changes that could not be saved, for example because the XML is not well-formed. Fix and save the document before writing text corrections.'

class TextCorrectionsPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'text-corrections', deps: ['client', 'tools'] })
  }

  get #client() { return this.getDependency('client') }

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
      const xmlEditor = this.getDependency('xmleditor')
      await xmlEditor.saveIfDirty()
      // the preview and the write use the stored document: refuse if the editor content is not it
      if (xmlEditor.isDirty() || !xmlEditor.getXmlTree()) {
        notify(UNSAVED_MESSAGE, 'warning', 'exclamation-triangle')
        testLog('TEXT_CORRECTIONS_REFUSED', { reason: 'unsaved' })
        return
      }
      const preview = await this.#client.apiClient.ocrTextCorrectionsPreview({ stable_id: stableId })
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
   * Fill and show the dialog. When the user confirms, the corrections are written while the dialog
   * stays open with the Write button in loading state.
   * @param {TextCorrectionsPreview} preview
   * @param {string} stableId
   * @returns {Promise<TextCorrectionsResult|null>} The result of writing, or null if the user did not confirm
   * @throws {Error} If writing failed
   */
  async #showDialog(preview, stableId) {
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
    fillList(dlg.affectedSection.affectedFiles, preview.affected_files.map(f => f.label || f.stable_id))
    // which versions stay with the old PDF only matters if the corrections can be written
    dlg.affectedSection.style.display = summary.canApply && preview.affected_files.length ? '' : 'none'
    dlg.write.style.display = summary.canApply ? '' : 'none'
    dlg.write.disabled = summary.needsSkip
    dlg.write.loading = false
    dlg.close.disabled = false

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
          dlg.summary.textContent = 'Writing the corrections to the PDF and updating the document. This can take a minute.'
          testLog('TEXT_CORRECTIONS_WRITING', { stableId })
          this.#client.apiClient.ocrTextCorrectionsApply({ stable_id: stableId, skip_unwritable: skipBox.checked })
            .then(resolve, reject)
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
