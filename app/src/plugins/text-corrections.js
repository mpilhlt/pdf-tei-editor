/**
 * Tools action "Write text corrections to PDF": shows the corrections a reviewer made in the TEI
 * document compared with the OCR text layer of the PDF, writes them into the text layer through the
 * backend and saves the returned TEI as a new version based on the corrected PDF.
 *
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { SlDialog, SlMenuItem } from '../ui.js'
 * @import { textCorrectionsDialogPart } from '../templates/text-corrections-dialog.types.js'
 * @import { TextCorrectionsPreview } from '../modules/api-client-v1.js'
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
   * Preview the corrections of the open document and, after confirmation, write them.
   * @returns {Promise<void>}
   */
  async run() {
    const stableId = this.state.xml
    if (!stableId || this.#busy) return
    this.#busy = true
    try {
      await this.getDependency('xmleditor').saveIfDirty()
      const preview = await this.#client.apiClient.ocrTextCorrectionsPreview({ stable_id: stableId })
      testLog('TEXT_CORRECTIONS_PREVIEW', {
        corrections: preview.corrections.length,
        unwritable: preview.unwritable.length,
        reason: preview.reason ?? null
      })
      const skip = await this.#showDialog(preview, stableId)
      if (skip === null) return
      await this.#apply(stableId, skip)
    } finally {
      this.#busy = false
    }
  }

  /**
   * Fill and show the dialog.
   * @param {TextCorrectionsPreview} preview
   * @param {string} stableId
   * @returns {Promise<boolean|null>} Whether to skip the unwritable changes, or null if the user did not confirm
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
    dlg.unwritableSection.skipUnwritable.style.display = summary.needsSkip ? '' : 'none'
    fillList(dlg.affectedSection.affectedFiles, preview.affected_files.map(f => f.label || f.stable_id))
    dlg.affectedSection.style.display = preview.affected_files.length ? '' : 'none'
    dlg.write.style.display = summary.canApply ? '' : 'none'
    dlg.write.disabled = summary.needsSkip

    const skipBox = dlg.unwritableSection.skipUnwritable
    const onSkipChange = () => { dlg.write.disabled = !skipBox.checked }
    skipBox.addEventListener('sl-change', onSkipChange)
    dlg.show()
    testLog('TEXT_CORRECTIONS_DIALOG_OPENED', { stableId, canApply: summary.canApply, needsSkip: summary.needsSkip })
    try {
      /** @type {boolean} */
      const confirmed = await new Promise(resolve => {
        const controller = new AbortController()
        const done = (/** @type {boolean} */ value) => { controller.abort(); resolve(value) }
        dlg.addEventListener('sl-request-close', () => done(false), { signal: controller.signal })
        dlg.close.addEventListener('click', () => done(false), { signal: controller.signal })
        dlg.write.addEventListener('click', () => done(true), { signal: controller.signal })
      })
      return confirmed ? skipBox.checked : null
    } finally {
      skipBox.removeEventListener('sl-change', onSkipChange)
      dlg.hide()
    }
  }

  /**
   * Write the corrections and load the returned TEI as a new version.
   * @param {string} stableId
   * @param {boolean} skipUnwritable
   * @returns {Promise<void>}
   */
  async #apply(stableId, skipUnwritable) {
    const result = await this.#client.apiClient.ocrTextCorrectionsApply({ stable_id: stableId, skip_unwritable: skipUnwritable })
    const xmlEditor = this.getDependency('xmleditor')
    try {
      // the editor autosaves on change: the old version must not receive the new XML
      await xmlEditor.loadXml(result.xml)
      xmlEditor.markAsClean()
      const { file_id: newFileId } = await this.getDependency('filedata').saveXml(stableId, true)
      xmlEditor.markAsClean()
      await this.getDependency('file-selection').reload({ refresh: true })
      await this.getDependency('services').load({ xml: newFileId })
      notify('Corrections written to the PDF. You are now editing a new version based on the corrected PDF.', 'success', 'check-circle')
      testLog('TEXT_CORRECTIONS_APPLIED', { newFileId, corrections: result.corrections })
    } catch (error) {
      const reason = /** @type {Error} */ (error)?.message ?? String(error)
      notify(`The corrections were already written to the PDF and the corrected document is in the editor, but it could not be saved or loaded as a new version (${reason}). Save it as a new version with the "Save revision" button, checking "Save to a new copy".`, 'danger', 'exclamation-octagon', 15000)
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
