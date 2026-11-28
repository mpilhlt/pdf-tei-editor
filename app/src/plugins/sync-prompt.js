/**
 * Sync prompt: when an edit makes the TEI text differ from data derived from the PDF (its text
 * layer, an extractor's training data such as GROBID's feature file), asks reviewers whether to
 * write the change into the PDF. The differences are the diagnostics of the sync sources (see
 * `registerSyncSource()` in lint-utils.js) that name a page; "Synchronize" writes the text
 * corrections of their pages (`TextCorrectionsPlugin#writePages()`), "Show changes" lists them in
 * the diagnostics drawer, where their fixes undo the changes.
 *
 * The prompt opens about two seconds after the last edit, for diagnostics that were not there
 * before the first edit since the document was loaded and that it did not ask about before. If the
 * document already has such diagnostics when it is loaded (e.g. corrections saved without writing
 * them into the PDF, or an extraction step that changed the text after the PDF was read), it asks
 * about them once per document version in this browser session, before the first edit.
 * Annotators, read-only documents and documents for which "Don't ask again" was checked (stored in
 * the browser by document id) get no prompt.
 *
 * The plugin also provides the "Write to PDF" button of the diagnostics drawer's "Differences from
 * the PDF" section, which writes the text corrections of the pages of the listed sync diagnostics.
 *
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlDialog } from '../ui.js'
 * @import { ViewUpdate } from '@codemirror/view'
 * @import { syncPromptDialogPart } from '../templates/sync-prompt-dialog.types.js'
 * @import { SyncEntry, PromptReason } from '../modules/sync-prompt.js'
 * @import { SyncDiagnostic } from '../modules/lint-utils.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { userHasReviewerRole, userIsAdmin } from '../modules/acl-utils.js'
import { getFileDataById } from '../modules/file-data-utils.js'
import { notify } from '../modules/sl-utils.js'
import { replacesDiagnostics, syncSourceNames } from '../modules/lint-utils.js'
import { newEntries, pagesOf, promptText, syncEntries } from '../modules/sync-prompt.js'
import { testLog } from '../modules/test-log.js'

await registerTemplate('sync-prompt-dialog', 'sync-prompt-dialog.html')

/** Delay after the last edit or diagnostics change before the prompt is considered */
export const PROMPT_DELAY_MS = 2000

/** Key of the UIStorage entry listing the documents (doc_id) for which the prompt is off */
const DONT_ASK_KEY = 'dontAskDocuments'

/** User events of edits made by the user */
const USER_EDIT_EVENTS = ['input', 'delete', 'move', 'undo', 'redo']

/** @typedef {'synchronize'|'show'|'cancel'} PromptChoice */

class SyncPromptPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'sync-prompt', deps: ['xmleditor', 'text-corrections', 'diagnostics-drawer'] })
  }

  /** @type {SlDialog & syncPromptDialogPart} */
  #ui = null

  /** @type {Set<string>} Keys of the sync diagnostics known before the first edit or already asked about */
  #known = new Set()

  /** True after the user edited the document since it was loaded */
  #edited = false

  /** @type {ReturnType<typeof setTimeout>|null} */
  #timer = null

  /** True while the prompt is shown or its synchronization runs */
  #busy = false

  /** @type {Set<string>} Versions (stable_id) whose differences at load were asked about in this session */
  #askedAtLoad = new Set()

  /** @param {ApplicationState} state */
  async install(state) {
    await super.install(state)
    this.#ui = this.createUi(createSingleFromTemplate('sync-prompt-dialog', document.body))
    this.getDependency('xmleditor').addUpdateListener(update => this.#onEditorUpdate(update))
    this.getDependency('diagnostics-drawer').setSyncAction({
      label: 'Write to PDF',
      title: 'Write the changes on these pages into the PDF',
      run: diagnostics => this.#writeDiagnostics(diagnostics)
    })
  }

  /**
   * @param {(keyof ApplicationState)[]} changedKeys
   * @param {ApplicationState} _state
   */
  async onStateUpdate(changedKeys, _state) {
    if (changedKeys.includes('xml')) {
      this.#known.clear()
      this.#edited = false
      this.#schedule()
    }
  }

  //
  // Public API
  //

  /**
   * Checks now (instead of after the delay) whether new sync diagnostics are there and asks about
   * them.
   * @returns {Promise<PromptChoice|null>} The choice, or null if the prompt was not shown
   */
  async check() {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    if (this.#busy) return null
    const view = this.getDependency('xmleditor').getView()
    if (!view) return null
    const entries = syncEntries(view.state)
    const added = newEntries(entries, this.#known)
    for (const entry of entries) this.#known.add(entry.key)
    if (!this.#mayAsk()) return null
    if (!this.#edited) {
      // differences that were there when the document was loaded
      const stableId = /** @type {string} */ (this.state?.xml)
      if (entries.length === 0 || this.#askedAtLoad.has(stableId)) return null
      this.#askedAtLoad.add(stableId)
      return await this.#ask(entries, 'load')
    }
    if (added.length === 0) return null
    return await this.#ask(added, 'edit')
  }

  /**
   * Whether the prompt is off for the open document ("Don't ask again").
   * @returns {boolean}
   */
  isOffForDocument() {
    const docId = this.#docId()
    return docId !== null && this.#dontAskDocuments().includes(docId)
  }

  //
  // Private methods
  //

  /** @param {ViewUpdate} update */
  #onEditorUpdate(update) {
    if (update.docChanged && update.transactions.some(tr => USER_EDIT_EVENTS.some(event => tr.isUserEvent(event)))) {
      this.#edited = true
    }
    if (update.docChanged || replacesDiagnostics(update)) this.#schedule()
  }

  /** Considers the prompt after the delay, once for several updates. */
  #schedule() {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.check().catch(error => this.getDependency('logger').warn(`Sync prompt failed: ${error}`))
    }, PROMPT_DELAY_MS)
  }

  /**
   * Whether the user can and wants to be asked: a reviewer or admin editing the document, without
   * "Don't ask again" for it.
   * @returns {boolean}
   */
  #mayAsk() {
    const user = this.state?.user ?? null
    if (!this.state?.xml || this.state.editorReadOnly) return false
    if (!userHasReviewerRole(user) && !userIsAdmin(user)) return false
    return !this.isOffForDocument()
  }

  /**
   * The document id of the open version, which "Don't ask again" is stored for, or its stable_id
   * if the file data does not have it yet.
   * @returns {string|null}
   */
  #docId() {
    const stableId = this.state?.xml ?? null
    if (!stableId) return null
    return getFileDataById(stableId)?.file?.doc_id ?? stableId
  }

  /** @returns {string[]} */
  #dontAskDocuments() {
    const stored = this.uiStorage.get(DONT_ASK_KEY, [])
    return Array.isArray(stored) ? stored : []
  }

  /** Turns the prompt off for the open document. */
  #setDontAsk() {
    const docId = this.#docId()
    if (docId === null) return
    const docs = this.#dontAskDocuments()
    if (!docs.includes(docId)) this.uiStorage.set(DONT_ASK_KEY, [...docs, docId])
  }

  /**
   * Writes the text corrections of the pages of the given sync diagnostics (the "Write to PDF"
   * button of the diagnostics drawer).
   * @param {SyncDiagnostic[]} diagnostics
   * @returns {Promise<void>}
   */
  async #writeDiagnostics(diagnostics) {
    const user = this.state?.user ?? null
    if (!userHasReviewerRole(user) && !userIsAdmin(user)) {
      notify('Only reviewers can write text corrections into the PDF.', 'warning', 'lock')
      return
    }
    const pages = [...new Set(diagnostics.map(d => d.page).filter(p => Number.isInteger(p)))]
      .map(p => /** @type {number} */ (p)).sort((a, b) => a - b)
    if (pages.length === 0) {
      notify('These differences cannot be written page by page. Use Tools › OCR › Write text corrections to PDF.', 'primary', 'info-circle')
      return
    }
    testLog('SYNC_WRITE_PAGES', { pages })
    await this.getDependency('text-corrections').writePages(pages)
  }

  /**
   * Shows the prompt and carries out the choice.
   * @param {SyncEntry[]} entries - The sync diagnostics asked about
   * @param {PromptReason} reason
   * @returns {Promise<PromptChoice>}
   */
  async #ask(entries, reason) {
    this.#busy = true
    try {
      const pages = pagesOf(entries)
      const choice = await this.#showDialog(entries, reason)
      testLog('SYNC_PROMPT_CLOSED', { choice, pages, reason, dontAsk: this.#ui.dontAsk.checked })
      if (this.#ui.dontAsk.checked) this.#setDontAsk()
      if (choice === 'show') {
        this.getDependency('diagnostics-drawer').showSources(syncSourceNames(), 'Sync changes')
      } else if (choice === 'synchronize') {
        await this.getDependency('text-corrections').writePages(pages)
      }
      return choice
    } finally {
      this.#busy = false
    }
  }

  /**
   * @param {SyncEntry[]} entries
   * @param {PromptReason} reason
   * @returns {Promise<PromptChoice>}
   */
  async #showDialog(entries, reason) {
    const dlg = this.#ui
    dlg.message.textContent = promptText(entries, reason)
    dlg.dontAsk.checked = false
    const controller = new AbortController()
    const { signal } = controller
    dlg.show()
    testLog('SYNC_PROMPT_OPENED', { pages: pagesOf(entries), count: entries.length, reason })
    try {
      return await new Promise(resolve => {
        dlg.addEventListener('sl-request-close', () => resolve('cancel'), { signal })
        dlg.notNow.addEventListener('click', () => resolve('cancel'), { signal })
        dlg.synchronize.addEventListener('click', () => resolve('synchronize'), { signal })
        dlg.showChanges.addEventListener('click', event => {
          event.preventDefault()
          resolve('show')
        }, { signal })
      })
    } finally {
      controller.abort()
      await dlg.hide()
    }
  }
}

export default SyncPromptPlugin
export { SyncPromptPlugin }
