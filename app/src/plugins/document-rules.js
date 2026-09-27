/**
 * Document Rules Plugin
 *
 * Provides two Tools-menu entries under the "document-rules" category:
 * - "Edit prompts/schemas": a dynamically populated submenu, one entry per
 *   resource (editorialDecl/interpretation entries + the document's schema)
 *   the currently open document references (POST /document-rules/list).
 *   Clicking an entry opens a shared per-resource editor dialog for
 *   switching between the original and the user's own overrides.
 * - "Refresh document rules" (reviewer/admin only): regenerates both halves
 *   of what governs a document - the interpretation-ref entries and the
 *   schema PI - via a preview-then-confirm-then-execute flow against
 *   POST /document-rules/refresh/{preview,execute}.
 *
 * Mirrors app/src/plugins/inference-settings.js's dynamic-Tools-submenu
 * pattern closely, including its field-naming convention (single-underscore
 * public fields/methods, not true #private ones, so this plugin's own unit
 * tests can reach them directly - see that file's module doc-comment).
 *
 * See docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
 * ("Frontend design").
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { UserData } from './authentication.js'
 * @import { SlMenuItem, SlDialog } from '../ui.js'
 * @import { documentRulesEditMenuItemPart } from '../templates/document-rules-menu-item.types.js'
 * @import { documentRulesEditorDialogPart } from '../templates/document-rules-editor-dialog.types.js'
 * @import { ResourceDescriptorModel, OverrideModel } from '../modules/api-client-v1.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { notify } from '../modules/sl-utils.js'
import { userHasRole } from '../modules/acl-utils.js'

// Register templates at module level
await registerTemplate('document-rules-menu-item', 'document-rules-menu-item.html')
await registerTemplate('document-rules-refresh-menu-item', 'document-rules-refresh-menu-item.html')
await registerTemplate('document-rules-editor-dialog', 'document-rules-editor-dialog.html')

class DocumentRulesPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'document-rules', deps: ['client', 'tools', 'xmleditor', 'dialog', 'services', 'logger'] })
  }

  get #client() { return this.getDependency('client') }
  get #xmlEditor() { return this.getDependency('xmleditor') }
  get #logger() { return this.getDependency('logger') }

  /** @type {SlMenuItem & documentRulesEditMenuItemPart} */
  _editMenuItem = null

  /** @type {HTMLElement} */
  _refreshMenuItem = null

  /** @type {SlDialog & documentRulesEditorDialogPart} */
  _editorDialogUi = null

  /**
   * Last successful POST /document-rules/list result for the open document.
   * @type {Array<ResourceDescriptorModel>}
   */
  _resources = []

  /** @type {Promise<void>|null} */
  _refreshPromise = null

  /** @type {boolean} */
  _refreshQueued = false

  /** @param {ApplicationState} state */
  async install(state) {
    await super.install(state)
    this.#logger.debug('Installing plugin "document-rules"')

    const dialog = createSingleFromTemplate('document-rules-editor-dialog', document.body)
    this._editorDialogUi = this.createUi(dialog)
    this._editorDialogUi.closeBtn.addEventListener('click', () => this._editorDialogUi.hide())
  }

  async start() {
    this.#logger.debug('Starting plugin "document-rules"')

    this._editMenuItem = this.createUi(createSingleFromTemplate('document-rules-menu-item'))
    this._refreshMenuItem = createSingleFromTemplate('document-rules-refresh-menu-item')

    this._editMenuItem.addEventListener('mouseenter', () => this._refreshResources())
    this._refreshMenuItem.addEventListener('click', () => this._onRefreshDocumentRules())

    this.getDependency('tools').addMenuItems([this._editMenuItem, this._refreshMenuItem], 'document-rules')

    this._refreshMenuItem.style.display = userHasRole(this.state.user, ['reviewer', 'admin']) ? '' : 'none'
    this._refreshResources()
  }

  /** Rebuild resource discovery when the open document changes. */
  onXmlChange() {
    if (this._editorDialogUi.open) this._editorDialogUi.hide()
    this._refreshResources()
  }

  /**
   * Show/hide the reviewer/admin-gated "Refresh document rules" item.
   * @param {UserData|null} newUser
   */
  onUserChange(newUser) {
    this._refreshMenuItem.style.display = userHasRole(newUser, ['reviewer', 'admin']) ? '' : 'none'
  }

  /**
   * Re-fetch the open document's resource list, de-duplicating concurrent
   * calls the same way inference-settings.js's _refresh() does: a call that
   * arrives while a fetch is already in flight joins that promise instead of
   * starting a second one, but marks _refreshQueued so one trailing refresh
   * fires once the in-flight fetch settles.
   * @returns {Promise<void>}
   */
  async _refreshResources() {
    if (this._refreshPromise) {
      this._refreshQueued = true
      return this._refreshPromise
    }
    this._refreshPromise = this.#doRefreshResources()
    try {
      await this._refreshPromise
    } finally {
      this._refreshPromise = null
      if (this._refreshQueued) {
        this._refreshQueued = false
        this._refreshResources()
      }
    }
  }

  /**
   * Does the actual fetch/rebuild work for _refreshResources(). Hides the
   * parent item entirely when no document is open; shows it disabled when a
   * document is open but references no resources; shows it enabled with a
   * populated submenu otherwise.
   * @returns {Promise<void>}
   */
  async #doRefreshResources() {
    const state = this.state
    if (!state.xml) {
      this._resources = []
      this._editMenuItem.style.display = 'none'
      return
    }

    let xmlString = null
    try {
      const view = this.#xmlEditor.getView()
      xmlString = view ? view.state.doc.toString() : null
    } catch (error) {
      this.#logger.warn('document-rules: could not read editor content: ' + String(error))
    }

    if (!xmlString) {
      this._resources = []
      this._editMenuItem.style.display = 'none'
      return
    }

    try {
      const response = await this.#client.apiClient.documentRulesList({ xml_string: xmlString })
      this._resources = response.resources
    } catch (error) {
      // Mirrors inference-settings.js's #doRefresh(): on a failed fetch, keep
      // whatever _resources this plugin already had (stale data is more
      // useful than an empty/hidden menu) rather than clearing it.
      this.#logger.warn('document-rules: could not list document resources: ' + String(error))
    }

    this._editMenuItem.style.display = ''
    this._editMenuItem.disabled = this._resources.length === 0
    this._populateSubmenu()
  }

  /** Rebuild the submenu's sl-menu-item children from `_resources`. */
  _populateSubmenu() {
    const submenu = this._editMenuItem.documentRulesEditSubmenu
    submenu.innerHTML = ''
    for (const resource of this._resources) {
      const item = document.createElement('sl-menu-item')
      item.textContent = resource.label
      item.dataset.kind = resource.kind
      item.dataset.url = resource.url
      item.addEventListener('click', () => this._openResourceEditor(resource))
      submenu.appendChild(item)
    }
  }

  /** @param {ResourceDescriptorModel} _resource */
  async _openResourceEditor(_resource) { /* replaced in Task 5 */ }

  /**
   * Preview, confirm, then execute a "Refresh document rules" pass on the
   * open document, reloading the editor from the server afterwards if
   * anything actually changed (services.load() always re-fetches the file
   * regardless of whether state.xml itself changed - see this plan's
   * "Important context" section).
   * @returns {Promise<void>}
   */
  async _onRefreshDocumentRules() {
    const state = this.state
    if (!state.xml) {
      notify('No document is open.', 'warning', 'exclamation-triangle')
      return
    }

    const dialog = this.getDependency('dialog')

    let preview
    try {
      preview = await this.#client.apiClient.documentRulesRefreshPreview({ xml: state.xml })
    } catch (error) {
      notify(`Could not preview the refresh: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }

    if (!preview.available) {
      notify(preview.message, 'warning', 'exclamation-triangle')
      return
    }

    const confirmed = await dialog.confirm(preview.message, 'Refresh document rules?')
    if (!confirmed) return

    let outcome
    try {
      outcome = await this.#client.apiClient.documentRulesRefreshExecute({ xml: state.xml })
    } catch (error) {
      notify(`Could not refresh document rules: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }

    if (outcome.changed) {
      await this.getDependency('services').load({ xml: state.xml })
    }
    notify(outcome.message, outcome.changed ? 'success' : 'primary', 'check-circle')
  }
}

export default DocumentRulesPlugin
