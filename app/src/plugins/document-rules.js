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
 * @import { ResourceDescriptorModel, OverrideModel, SelectionInfo } from '../modules/api-client-v1.js'
 * @import { StatusText } from '../modules/panels/index.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { notify } from '../modules/sl-utils.js'
import { userHasRole } from '../modules/acl-utils.js'
import { createMarkdownRenderer } from '../modules/markdown-utils.js'
import { PanelUtils } from '../modules/panels/index.js'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { xml } from '@codemirror/lang-xml'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { getTheme } from '../modules/codemirror/editor-themes.js'
import { createOverrideRefField, createOverrideRefClickHandler, refDecorationTheme } from '../modules/document-rules-decorations.js'

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

  /** @type {StatusText|null} */
  _overridesWidget = null

  /**
   * Last successful POST /document-rules/selections result for `_resources`.
   * @type {Array<SelectionInfo>}
   */
  _selections = []

  /** @type {Promise<void>|null} */
  _refreshPromise = null

  /** @type {boolean} */
  _refreshQueued = false

  /** @type {ReturnType<typeof createMarkdownRenderer>} */
  _md = null

  /** Resource descriptor the dialog currently shows, or null if closed. @type {ResourceDescriptorModel|null} */
  _currentResource = null

  /** @type {Array<OverrideModel>} */
  _currentOverrides = []

  /** Selected override id, or null when "Original" is selected. @type {string|null} */
  _currentSelectedId = null

  /** @type {string} */
  _currentOriginalText = ''

  /**
   * Whether the host document (the main XML editor) is currently read-only -
   * kept in sync via onEditorReadOnlyChange(). Independent of, and combined
   * with, the dialog's own "read-only unless an override is selected" gating
   * in _renderEditorDialog().
   * @type {boolean}
   */
  _documentReadOnly = false

  /** @type {{reconfigure: (ext: any) => void}} */
  _refDecorationSlot = null

  /** @type {EditorView} */
  _cmView = null

  /** @type {Compartment} */
  _cmReadOnlyCompartment = new Compartment()

  /**
   * Wraps history() so it can be cleared on every _setXmlContent() call -
   * without this, undo/redo would leak content across different resources/
   * overrides shown in the same long-lived CM instance (see
   * app/src/modules/xmleditor.js's loadXml(), which clears history the same
   * way on every document load).
   * @type {Compartment}
   */
  _cmHistoryCompartment = new Compartment()

  /** @param {ApplicationState} state */
  async install(state) {
    await super.install(state)
    this.#logger.debug('Installing plugin "document-rules"')
    this._documentReadOnly = !!state.editorReadOnly

    const dialog = createSingleFromTemplate('document-rules-editor-dialog', document.body)
    this._editorDialogUi = this.createUi(dialog)

    this._md = createMarkdownRenderer()

    this._overridesWidget = PanelUtils.createText({
      text: 'Overrides active',
      icon: 'pencil-fill',
      variant: 'primary',
      clickable: true,
      name: 'documentRulesOverridesStatus'
    })
    this._overridesWidget.addEventListener('widget-click', () => this._onOverridesWidgetClick())

    // Reuse the user's own XML-editor theme choice (persisted the same way
    // xmleditor.js reads it) rather than hardcoding 'default' - otherwise a
    // user who switched the main editor to dark mode would see this dialog's
    // schema view rendered in light mode regardless. `this.uiStorage` is
    // namespaced by THIS plugin's own name ('document-rules'), which is not
    // where xmleditor.js's plugin ('xmleditor') persists the setting - it
    // must be read from that plugin's own namespace instead.
    const themeId = this.context.getUIStorage('xmleditor').get('editorTheme', 'default')

    this._cmView = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(),
          this._cmHistoryCompartment.of(history()),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          xml(),
          getTheme(themeId).extensions,
          this._cmReadOnlyCompartment.of([EditorView.editable.of(false), EditorState.readOnly.of(true)])
        ]
      }),
      parent: this._editorDialogUi.xmlBody.xmlContainer
    })

    this._refDecorationSlot = this.#xmlEditor.createExtensionSlot([])

    this._editorDialogUi.closeBtn.addEventListener('click', () => this._editorDialogUi.hide())
    this._editorDialogUi.newOverrideBtn.addEventListener('click', () => this._onNewOverride())
    this._editorDialogUi.saveBtn.addEventListener('click', () => this._onSave())
    this._editorDialogUi.deleteBtn.addEventListener('click', () => this._onDelete())
    this._editorDialogUi.resetBtn.addEventListener('click', () => this._onReset())
    this._editorDialogUi.textBody.textTabs.addEventListener('sl-tab-show', (event) => {
      if (/** @type {CustomEvent} */(event).detail.name === 'preview') {
        const text = this._editorDialogUi.textBody.textTabs.editPanel.textArea.value
        this._editorDialogUi.textBody.textTabs.previewPanel.previewContent.innerHTML = this._md.render(text)
      }
    })
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
   * Keep the resource editor dialog's content-editing controls in sync with
   * the host document's read-only state - independent of, and in addition
   * to, the dialog's existing "read-only unless an override is selected"
   * gating in _renderEditorDialog().
   * @param {boolean} newValue
   */
  onEditorReadOnlyChange(newValue) {
    this._documentReadOnly = !!newValue
    if (this._currentResource) this._renderEditorDialog()
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
    await this._refreshOverrideIndicators()
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

  /**
   * Reveal the document's editorialDecl: unfold the TEI header (it may be
   * folded) and scroll editorialDecl into view - same two calls
   * app/src/plugins/tei-tools.js's own "show header" toggle makes (that
   * plugin's toggle logic is private, so this duplicates the calls rather
   * than depending on it).
   */
  _onOverridesWidgetClick() {
    try {
      this.#xmlEditor.unfoldByXpath('//tei:teiHeader')
      this.#xmlEditor.selectByXpath('//tei:editorialDecl')
    } catch (error) {
      this.#logger.warn('document-rules: could not reveal editorialDecl: ' + String(error))
    }
  }

  /**
   * Fetch selection status for every currently-known resource and show/hide
   * the "Overrides active" headerbar widget accordingly. Called whenever
   * `_resources` changes (after a list refresh) and whenever a selection
   * changes (override CRUD/selection actions), so the indicator - and the
   * ref decorations built from the same `_selections` data - stay current.
   * @returns {Promise<void>}
   */
  async _refreshOverrideIndicators() {
    if (this._resources.length === 0) {
      this._selections = []
      if (this._overridesWidget.isConnected) this.#xmlEditor.removeHeaderbarWidget(this._overridesWidget.id)
      this._refreshRefDecorations()
      return
    }
    try {
      const response = await this.#client.apiClient.documentRulesSelections({
        resources: this._resources.map(r => ({ kind: r.kind, url: r.url }))
      })
      this._selections = response.selections
    } catch (error) {
      this.#logger.warn('document-rules: could not fetch selection status: ' + String(error))
      return
    }
    const hasOverrides = this._selections.some(s => s.selected)
    if (hasOverrides) {
      if (!this._overridesWidget.isConnected) this.#xmlEditor.addHeaderbarWidget(this._overridesWidget, 'right', 3)
    } else if (this._overridesWidget.isConnected) {
      this.#xmlEditor.removeHeaderbarWidget(this._overridesWidget.id)
    }
    this._refreshRefDecorations()
  }

  /**
   * Rebuild the ref-decoration extension from the current `_selections`,
   * restricted to interpretation-ref resources (the schema PI isn't a <ref>
   * element, so it's never decorated this way).
   */
  _refreshRefDecorations() {
    const overriddenUrls = new Set(
      this._selections.filter(s => s.selected && s.kind === 'interpretation-ref').map(s => s.url)
    )
    this._refDecorationSlot.reconfigure([
      createOverrideRefField(overriddenUrls),
      refDecorationTheme,
      createOverrideRefClickHandler((url) => this._onRefDecorationClick(url))
    ])
  }

  /**
   * Open the resource editor for the interpretation-ref resource matching
   * the clicked <ref target="..."> URL, looked up in the existing
   * `_resources` cache (see this plan's "Important context" on staleness).
   * @param {string} url
   */
  _onRefDecorationClick(url) {
    const resource = this._resources.find(r => r.kind === 'interpretation-ref' && r.url === url)
    if (!resource) {
      this.#logger.warn(`document-rules: no resource found for clicked ref url: ${url}`)
      return
    }
    this._openResourceEditor(resource)
  }

  /**
   * Query one resource's original text, overrides, and current selection,
   * then render and show the editor dialog for it.
   * @param {ResourceDescriptorModel} resource
   * @returns {Promise<void>}
   */
  async _openResourceEditor(resource) {
    let response
    try {
      response = await this.#client.apiClient.documentRulesQuery({ kind: resource.kind, url: resource.url })
    } catch (error) {
      notify(`Could not load resource: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    this._currentResource = resource
    this._currentOverrides = response.overrides
    this._currentSelectedId = response.selected_override_id
    this._currentOriginalText = response.original_text
    this._renderEditorDialog()
    this._editorDialogUi.show()
  }

  /**
   * Read the text currently displayed in whichever body is active (the
   * source of truth for New override/Save, before it's persisted).
   * @returns {string}
   */
  _currentShownText() {
    if (this._currentResource.format === 'xml') {
      return this._currentXmlText()
    }
    return this._editorDialogUi.textBody.textTabs.editPanel.textArea.value
  }

  /** Full re-render of the dialog for `_currentResource`/`_currentOverrides`/`_currentSelectedId`. */
  _renderEditorDialog() {
    const resource = this._currentResource
    const dialogUi = this._editorDialogUi
    dialogUi.setAttribute('label', resource.label)
    this._renderOverrideRow()

    const selected = this._currentOverrides.find(o => o.id === this._currentSelectedId) ?? null
    dialogUi.noteInput.style.display = selected ? '' : 'none'
    dialogUi.noteInput.value = selected ? selected.note : ''
    dialogUi.noteInput.disabled = this._documentReadOnly

    const text = selected ? selected.text : this._currentOriginalText
    const readOnly = selected === null || this._documentReadOnly

    if (resource.format === 'xml') {
      dialogUi.textBody.style.display = 'none'
      dialogUi.xmlBody.style.display = ''
      this._setXmlContent(text, readOnly)
    } else {
      dialogUi.xmlBody.style.display = 'none'
      dialogUi.textBody.style.display = ''
      dialogUi.textBody.textTabs.editPanel.textArea.value = text
      dialogUi.textBody.textTabs.editPanel.textArea.readonly = readOnly
      dialogUi.textBody.textTabs.previewPanel.previewContent.innerHTML = this._md.render(text)
    }

    dialogUi.newOverrideBtn.disabled = this._documentReadOnly
    dialogUi.saveBtn.style.display = selected && !this._documentReadOnly ? '' : 'none'
    dialogUi.deleteBtn.style.display = selected ? '' : 'none'
    dialogUi.resetBtn.style.display = selected ? '' : 'none'
  }

  /** Rebuild the "Original"/"Override N" button row. */
  _renderOverrideRow() {
    const row = this._editorDialogUi.overrideRow
    row.innerHTML = ''

    const originalBtn = document.createElement('sl-button')
    originalBtn.setAttribute('size', 'small')
    originalBtn.textContent = 'Original'
    originalBtn.variant = this._currentSelectedId === null ? 'primary' : 'default'
    originalBtn.addEventListener('click', () => this._selectOverride(null))
    row.appendChild(originalBtn)

    this._currentOverrides.forEach((override, index) => {
      const btn = document.createElement('sl-button')
      btn.setAttribute('size', 'small')
      btn.textContent = `Override ${index + 1}`
      btn.variant = this._currentSelectedId === override.id ? 'primary' : 'default'
      if (override.note) btn.title = override.note
      btn.addEventListener('click', () => this._selectOverride(override.id))
      row.appendChild(btn)
    })
  }

  /**
   * Select the original (null) or one override for `_currentResource`,
   * persisting the choice immediately - per the spec, clicking a row entry
   * "uses it immediately", it is not a staged/unsaved choice.
   * @param {string|null} overrideId
   * @returns {Promise<void>}
   */
  async _selectOverride(overrideId) {
    if (overrideId === this._currentSelectedId) return
    try {
      await this.#client.apiClient.documentRulesSelection({
        kind: this._currentResource.kind,
        fragment_url: this._currentResource.url,
        override_id: overrideId
      })
    } catch (error) {
      notify(`Could not change selection: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    this._currentSelectedId = overrideId
    this._renderEditorDialog()
    await this._refreshOverrideIndicators()
  }

  /**
   * Copy the currently shown text into a new override and select it.
   * @returns {Promise<void>}
   */
  async _onNewOverride() {
    const text = this._currentShownText()
    let override
    try {
      override = await this.#client.apiClient.documentRulesOverrides({
        kind: this._currentResource.kind,
        fragment_url: this._currentResource.url,
        note: '',
        text
      })
    } catch (error) {
      notify(`Could not create override: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    this._currentOverrides.push(override)
    await this._selectOverride(override.id)
  }

  /**
   * Persist the currently selected override's note + shown text.
   * @returns {Promise<void>}
   */
  async _onSave() {
    if (this._currentSelectedId === null) return
    const note = this._editorDialogUi.noteInput.value
    const text = this._currentShownText()
    let updated
    try {
      updated = await this.#client.apiClient.documentRulesUpdateOverrides(this._currentSelectedId, { note, text })
    } catch (error) {
      notify(`Could not save override: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    const index = this._currentOverrides.findIndex(o => o.id === updated.id)
    if (index !== -1) this._currentOverrides[index] = updated
    // Refresh just the override row, not the full dialog - the note/text
    // already shown are exactly what was just submitted, but the row's
    // per-button tooltip (set from override.note at render time) would
    // otherwise stay stale until some other action forces a re-render.
    this._renderOverrideRow()
    notify('Override saved.', 'success', 'check-circle')
  }

  /**
   * Delete the currently selected override (owner-only, enforced server-side).
   * @returns {Promise<void>}
   */
  async _onDelete() {
    if (this._currentSelectedId === null) return
    const confirmed = await this.getDependency('dialog').confirm('Delete this override? This cannot be undone.', 'Delete override')
    if (!confirmed) return
    const id = this._currentSelectedId
    try {
      await this.#client.apiClient.documentRulesDeleteOverrides(id)
    } catch (error) {
      notify(`Could not delete override: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    this._currentOverrides = this._currentOverrides.filter(o => o.id !== id)
    this._currentSelectedId = null
    this._renderEditorDialog()
    await this._refreshOverrideIndicators()
  }

  /**
   * Clear the selection for this resource (keeps all overrides).
   * @returns {Promise<void>}
   */
  async _onReset() {
    if (this._currentSelectedId === null) return
    try {
      await this.#client.apiClient.documentRulesSelection({
        kind: this._currentResource.kind,
        fragment_url: this._currentResource.url,
        override_id: null
      })
    } catch (error) {
      notify(`Could not reset selection: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    this._currentSelectedId = null
    this._renderEditorDialog()
    await this._refreshOverrideIndicators()
  }

  /**
   * Replace the CodeMirror doc's full content, toggle its read-only
   * compartment (both the DOM-level EditorView.editable and the
   * command-level EditorState.readOnly facet - the latter is what actually
   * makes CodeMirror's own undo/redo refuse to run while read-only; toggling
   * only `editable` leaves Ctrl+Z/Ctrl+Y still active), and clear undo/redo
   * history so a previous resource's/override's content can never resurface
   * via undo in what's now showing a different one. Mirrors
   * app/src/modules/xmleditor.js's setReadOnly() and clearHistory().
   * @param {string} text
   * @param {boolean} readOnly
   */
  _setXmlContent(text, readOnly) {
    this._cmView.dispatch({
      changes: { from: 0, to: this._cmView.state.doc.length, insert: text },
      effects: [
        this._cmReadOnlyCompartment.reconfigure([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]),
        this._cmHistoryCompartment.reconfigure([])
      ]
    })
    this._cmView.dispatch({ effects: this._cmHistoryCompartment.reconfigure(history()) })
  }

  /** @returns {string} */
  _currentXmlText() {
    return this._cmView.state.doc.toString()
  }

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
      try {
        await this.getDependency('services').load({ xml: state.xml })
      } catch (error) {
        // The refresh itself already succeeded server-side; only the
        // editor reload failed, so still confirm the refresh and report
        // the reload failure separately rather than losing both messages
        // to an unhandled rejection (services.load() can rethrow on a
        // lock/permission error even for a file the caller already holds).
        notify(outcome.message, 'success', 'check-circle')
        notify(`Refresh succeeded, but reloading the editor failed: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
        return
      }
    }
    notify(outcome.message, outcome.changed ? 'success' : 'primary', 'check-circle')
  }
}

export default DocumentRulesPlugin
