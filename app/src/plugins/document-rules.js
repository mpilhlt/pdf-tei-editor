/**
 * Document Rules Plugin
 *
 * Provides two Tools-menu entries under the "document-rules" category:
 * - "Edit document rules": a dynamically populated submenu, one entry per
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
 * @import { documentRulesUpdateDialogPart } from '../templates/document-rules-update-dialog.types.js'
 * @import { documentRulesProposeDialogPart } from '../templates/document-rules-propose-dialog.types.js'
 * @import { ResourceDescriptorModel, OverrideModel, SelectionInfo, RefreshResourceResponse, SyncStatusResponse, HumanChangeResponse, ProposePatchResponse, ProposePullRequestResponse, UpstreamStatusResponse } from '../modules/api-client-v1.js'
 * @import { ModelChoice } from './inference-settings.js'
 * @import { StatusText } from '../modules/panels/index.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { notify } from '../modules/sl-utils.js'

// Icons set via setAttribute() (needed for the build system to include them)
// <sl-icon name="cloud-check"></sl-icon>
// <sl-icon name="arrow-repeat"></sl-icon>
import { userHasRole } from '../modules/acl-utils.js'
import { createMarkdownRenderer, findHeadingLineForAnchor } from '../modules/markdown-utils.js'
import { PanelUtils } from '../modules/panels/index.js'
import { EditorState, Compartment } from '@codemirror/state'
import { unifiedMergeView } from '@codemirror/merge'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { xml, xmlLanguage } from '@codemirror/lang-xml'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { getTheme } from '../modules/codemirror/editor-themes.js'
import { dialogSearch } from '../modules/codemirror/dialog-search.js'
import { createOverrideRefField, createOverrideRefClickHandler, refDecorationTheme } from '../modules/document-rules-decorations.js'

// Register templates at module level
await registerTemplate('document-rules-menu-item', 'document-rules-menu-item.html')
await registerTemplate('document-rules-refresh-menu-item', 'document-rules-refresh-menu-item.html')
await registerTemplate('document-rules-editor-dialog', 'document-rules-editor-dialog.html')
await registerTemplate('document-rules-update-dialog', 'document-rules-update-dialog.html')
await registerTemplate('document-rules-propose-dialog', 'document-rules-propose-dialog.html')

// Matches a recognized line-range fragment (GitHub's #L10-L50, GitLab's
// #L10-50) - mirrors annotation_rules_utils.py's _LINE_RANGE_RE.
const LINE_RANGE_FRAGMENT_RE = /^L\d+(-L?\d+)?$/

const OUTDATED_OVERRIDE_TOOLTIP = 'Based on an older version of the original'
const IN_UPSTREAM_OVERRIDE_TOOLTIP = 'Upstream contains this text; it is removed when you update to upstream.'

const ALIGN_MODE_NOTICE = 'No sync base found: the model compares the whole guide section with the machine rules.'
const UNCHANGED_GUIDE_NOTICE = 'The guide section has not changed since the last sync.'
const NO_MODEL_NOTICE = 'No language model is available. Update the machine rules by hand, using the change shown above.'
const REPEATED_UPDATE_NOTICE = 'The selected machine rules were already updated from the guide. Running the update again may apply the same change twice.'

// Notices of the "Propose upstream" sub-dialog, by the layers included in the proposal
const GUIDE_ONLY_PROPOSAL_NOTICE = 'The machine rules will be marked as outdated until they are updated from the guide.'
const MACHINE_PROPOSAL_NOTICE = 'The sync marker is updated: the machine rules are marked as in sync with the guide.'
const MACHINE_OUTDATED_PROPOSAL_NOTICE = 'The machine rules were derived from a guide text that differs from the guide upstream; they will be marked as outdated.'
const UNSAVED_PROPOSAL_NOTICE = 'Unsaved changes in the editor are not included. Save them first.'

/**
 * The propose sub-dialog's notice for a file whose section changed upstream since the pinned version.
 * @param {string} path - The file's repository path
 * @returns {string}
 */
function upstreamChangedNotice(path) {
  return `The section in ${path} changed upstream since your version; the patch replaces those changes.`
}

// Note of an override accepted in the "Update machine rules from guide" sub-dialog, followed by the model label
const UPDATED_FROM_GUIDE_NOTE_PREFIX = 'Updated from guide with '

/**
 * Markdown language support for the dialogs' CodeMirror views. GFM
 * (tables/strikethrough/autolink/task lists) matches what the preview's
 * markdown-it renderer (createMarkdownRenderer()) already supports by
 * default; xmlLanguage highlights ```xml fenced code blocks, since
 * annotation guides often embed TEI/XML examples.
 */
function markdownLanguage() {
  return markdown({ extensions: GFM, codeLanguages: (info) => info === 'xml' ? xmlLanguage : null })
}

/**
 * Status-line copy for each sync status of a human/machine layer pair (see
 * POST /document-rules/sync-status).
 * @type {Readonly<Record<SyncStatusResponse['status'], string>>}
 */
const SYNC_STATUS_TEXT = Object.freeze({
  in_sync: 'In sync with the guide',
  machine_outdated: 'Machine rules outdated: the guide changed since the last sync',
  machine_edited: 'Machine rules edited by hand since the last sync',
  both_changed: 'Machine rules outdated and edited by hand',
  no_marker: 'No sync marker'
})

/**
 * The URL fragment to scroll the markdown edit/preview panels to, or null
 * if there is none, or it's a recognized line-range fragment instead (e.g.
 * "#L10-L40"). `fetch_rule_excerpt()` (annotation_rules_utils.py) already
 * slices `original_text` to a line-range fragment server-side, so there's
 * nothing left to scroll to for those; a heading-anchor fragment (e.g.
 * "#data-correction", an interpretation-ref "human" ref - see
 * docs/development/tei-header-integrations.md), by contrast, leaves the
 * *whole* document as `original_text` - the client scrolls to the
 * referenced heading itself.
 * @param {string} url
 * @returns {string|null}
 */
function headingAnchorFragment(url) {
  const hashIndex = url.indexOf('#')
  if (hashIndex === -1) return null
  const fragment = url.slice(hashIndex + 1)
  return fragment && !LINE_RANGE_FRAGMENT_RE.test(fragment) ? fragment : null
}

/**
 * Names of the layers in the upstream status line's error messages.
 * @type {Readonly<Record<string, string>>}
 */
const UPSTREAM_LAYER_NAME = Object.freeze({ human: 'Guide', machine: 'Machine rules' })

/**
 * Number of override ids in one list of all layers of an upstream status.
 * @param {UpstreamStatusResponse|null} status
 * @param {'in_upstream'|'kept'} list
 * @returns {number}
 */
function countUpstreamIds(status, list) {
  return status ? status.layers.reduce((sum, layer) => sum + layer[list].length, 0) : 0
}

/**
 * "1 override" / "N overrides".
 * @param {number} count
 * @returns {string}
 */
function pluralizeOverrides(count) {
  return `${count} ${count === 1 ? 'override' : 'overrides'}`
}

class DocumentRulesPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'document-rules', deps: ['client', 'tools', 'xmleditor', 'dialog', 'services', 'logger', 'inference-settings', 'api-keys'] })
  }

  get #client() { return this.getDependency('client') }
  get #xmlEditor() { return this.getDependency('xmleditor') }
  get #logger() { return this.getDependency('logger') }
  get #inferenceSettings() { return this.getDependency('inference-settings') }

  /** @type {SlMenuItem & documentRulesEditMenuItemPart} */
  _editMenuItem = null

  /** @type {HTMLElement} */
  _refreshMenuItem = null

  /** @type {SlDialog & documentRulesEditorDialogPart} */
  _editorDialogUi = null

  /** "Update machine rules from guide" sub-dialog. @type {SlDialog & documentRulesUpdateDialogPart} */
  _updateDialogUi = null

  /**
   * Models offered by the sub-dialog's model picker; an option's value is
   * its index here (an `<sl-select>` value cannot hold arbitrary ids).
   * @type {Array<ModelChoice>}
   */
  _updateModels = []

  /** The sub-dialog's guide-change merge view, destroyed when it closes. @type {EditorView|null} */
  _humanDiffView = null

  /** The sub-dialog's proposal merge view, destroyed when it closes. @type {EditorView|null} */
  _proposedDiffView = null

  /**
   * Incremented whenever the sub-dialog is reset (opened or closed), so a
   * Generate response that outlives its dialog session is dropped.
   */
  _updateDialogSession = 0

  /** Number of _openUpdateDialog() requests so far; only the latest one may open the sub-dialog. */
  _updateDialogOpenRequest = 0

  /** Proposed machine rules from the last successful Generate, or null. @type {string|null} */
  _proposedMachineText = null

  /** The model `_proposedMachineText` was generated with. @type {ModelChoice|null} */
  _proposedModel = null

  /** "Propose upstream" sub-dialog of a human/machine pair. @type {SlDialog & documentRulesProposeDialogPart} */
  _proposeDialogUi = null

  /** The propose sub-dialog's per-file merge views, destroyed when it closes. @type {Array<EditorView>} */
  _proposalViews = []

  /** The proposal the propose sub-dialog shows, or null. @type {ProposePatchResponse|null} */
  _proposal = null

  /**
   * Incremented on every _refreshProposal() call and when the propose
   * sub-dialog is reset, so only the latest request's response is shown.
   */
  _proposalSession = 0

  /** The latest _refreshProposal() call. @type {Promise<void>|null} */
  _proposalPromise = null

  /** Whether the user edited the pull request title since the propose sub-dialog opened. */
  _prTitleEdited = false

  /** Whether the user edited the pull request description since the propose sub-dialog opened. */
  _prBodyEdited = false

  /**
   * Incremented when the propose sub-dialog is reset, so the result of a
   * pull request created before is not shown after it was reopened.
   */
  _pullRequestSession = 0

  /** Whether a pull request is being created from the propose sub-dialog. */
  _pullRequestPending = false

  /** Whether a pull request was created since the propose sub-dialog opened. */
  _pullRequestCreated = false

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

  /**
   * All layers of the rule category `_currentResource` belongs to (see
   * _resourceGroups()) - two descriptors ("human", "machine") for a
   * two-layer interpretation-ref category, otherwise just `_currentResource`.
   * @type {Array<ResourceDescriptorModel>}
   */
  _currentGroup = []

  /** @type {Array<OverrideModel>} */
  _currentOverrides = []

  /**
   * Number of _refreshSyncStatus() calls so far; a response is only shown
   * if no newer call started while it was pending.
   */
  _syncStatusRequest = 0

  /**
   * Human and machine url of the pair the sync status line last described
   * (newline-joined), or null when it described none.
   * @type {string|null}
   */
  _syncStatusPair = null

  /**
   * Last upstream status of `_currentGroup`'s overrides (see
   * _refreshUpstreamStatus()), or null for a resource that has none.
   * @type {UpstreamStatusResponse|null}
   */
  _upstreamStatus = null

  /**
   * Number of _refreshUpstreamStatus() calls so far; a response is only
   * used if no newer call started while it was pending.
   */
  _upstreamStatusRequest = 0

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

  /**
   * CodeMirror instance for the "Edit" tab of markdown/text resources -
   * replaces a plain `<sl-textarea>` (see _setMarkdownContent()'s doc
   * comment on why: a native textarea has no reliable, wrap-aware way to
   * scroll to a specific source line, which is exactly what
   * _scrollMarkdownBodyToAnchor() needs for a heading-anchor fragment).
   * @type {EditorView}
   */
  _cmMdView = null

  /** @type {Compartment} */
  _cmMdReadOnlyCompartment = new Compartment()

  /** Mirrors _cmHistoryCompartment, for _cmMdView. @type {Compartment} */
  _cmMdHistoryCompartment = new Compartment()

  /** @param {ApplicationState} state */
  async install(state) {
    await super.install(state)
    this.#logger.debug('Installing plugin "document-rules"')
    this._documentReadOnly = !!state.editorReadOnly

    const dialog = createSingleFromTemplate('document-rules-editor-dialog', document.body)
    this._editorDialogUi = this.createUi(dialog)
    this._updateDialogUi = this.createUi(createSingleFromTemplate('document-rules-update-dialog', document.body))
    this._proposeDialogUi = this.createUi(createSingleFromTemplate('document-rules-propose-dialog', document.body))

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
    // schema view rendered in light mode regardless.
    const themeId = this._editorThemeId()

    this._cmView = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(),
          this._cmHistoryCompartment.of(history()),
          dialogSearch(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          xml(),
          getTheme(themeId).extensions,
          this._cmReadOnlyCompartment.of([EditorView.editable.of(false), EditorState.readOnly.of(true)])
        ]
      }),
      parent: this._editorDialogUi.xmlBody.xmlContainer
    })

    this._cmMdView = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          markdownLanguage(),
          EditorView.lineWrapping,
          // CodeMirror only scrolls internally (what EditorView.scrollIntoView()
          // in _scrollMarkdownBodyToAnchor() needs) once its own `.cm-scroller`
          // is the actual overflow container - by default (no explicit height),
          // `.cm-editor` grows to fit its content and the *outer* mdContainer
          // div does the scrolling instead, in which case scrollIntoView() has
          // nothing to scroll and silently no-ops. This theme constrains
          // `.cm-editor`'s height so `.cm-scroller` becomes scrollable,
          // mirroring the fixed-height/overflow:auto the xmlContainer div gets
          // via plain CSS (its CM instance never scrolls to a specific
          // position programmatically, so it never needed this).
          EditorView.theme({ '&': { height: '400px' }, '.cm-scroller': { overflow: 'auto' } }),
          this._cmMdHistoryCompartment.of(history()),
          dialogSearch(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          getTheme(themeId).extensions,
          this._cmMdReadOnlyCompartment.of([EditorView.editable.of(false), EditorState.readOnly.of(true)])
        ]
      }),
      parent: this._editorDialogUi.textBody.textTabs.editPanel.mdContainer
    })

    this._refDecorationSlot = this.#xmlEditor.createExtensionSlot([])

    this._editorDialogUi.closeBtn.addEventListener('click', () => this._editorDialogUi.hide())
    this._editorDialogUi.newOverrideBtn.addEventListener('click', () => this._onNewOverride())
    this._editorDialogUi.saveBtn.addEventListener('click', () => this._onSave())
    this._editorDialogUi.deleteBtn.addEventListener('click', () => this._onDelete())
    this._editorDialogUi.resetBtn.addEventListener('click', () => this._onReset())
    this._editorDialogUi.updateToUpstreamBtn.addEventListener('click', () => this._onUpdateToUpstream())
    this._editorDialogUi.proposeUpstreamBtn.addEventListener('click', () => this._onProposeUpstreamClick())
    this._editorDialogUi.updateFromGuideBtn.addEventListener('click', () => this._openUpdateDialog())
    this._updateDialogUi.modelRow.generateBtn.addEventListener('click', () => this._onGenerate())
    this._updateDialogUi.acceptBtn.addEventListener('click', () => this._onAcceptProposal())
    this._updateDialogUi.closeBtn.addEventListener('click', () => this._updateDialogUi.hide())
    this._updateDialogUi.addEventListener('sl-after-hide', (event) => {
      // Nested Shoelace components (the model picker) emit their own sl-after-hide
      if (event.target === this._updateDialogUi) this._resetUpdateDialog()
    })
    this._installProposeDialogListeners()
    this._editorDialogUi.layerTabs.addEventListener('sl-tab-show', (event) => {
      this._onLayerTabShow(/** @type {CustomEvent} */(event).detail.name).catch(error => {
        this.#logger.warn('document-rules: could not switch layer: ' + String(error))
      })
    })
    this._editorDialogUi.textBody.textTabs.addEventListener('sl-tab-show', async (event) => {
      if (/** @type {CustomEvent} */(event).detail.name === 'preview') {
        const previewPanel = this._editorDialogUi.textBody.textTabs.previewPanel
        const text = this._cmMdView.state.doc.toString()
        previewPanel.previewContent.innerHTML = this._md.render(text)
        // Re-scroll now that the preview panel is actually visible - see
        // _scrollMarkdownBodyToAnchor()'s doc comment on why setting scroll
        // position on a hidden `display: none` panel has no effect. This
        // event fires synchronously from setActiveTab() right after setting
        // the panel's `active` property, but - like _openResourceEditor()'s
        // own forced tab-show - that property's reflection to the actual
        // `active` DOM attribute (which the panel's display:none/block CSS
        // depends on) lands asynchronously via the panel's own Lit update,
        // not synchronously inside this handler; without awaiting it here,
        // scrollIntoView() below fires while the panel is still hidden and
        // permanently no-ops (nothing re-attempts it afterwards).
        await previewPanel.updateComplete
        if (this._currentResource) this._scrollMarkdownBodyToAnchor(text)
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

    // _editMenuItem starts hidden regardless of role - #doRefreshResources()
    // (triggered by the _refreshResources() call below) is the only place
    // that ever shows it, and only once its own role check passes.
    this._editMenuItem.style.display = 'none'
    this._refreshMenuItem.style.display = userHasRole(this.state.user, ['reviewer', 'admin']) ? '' : 'none'
    this._refreshResources()
  }

  /** Rebuild resource discovery when the open document changes. */
  onXmlChange() {
    if (this._updateDialogUi.open) this._updateDialogUi.hide()
    if (this._proposeDialogUi.open) this._proposeDialogUi.hide()
    if (this._editorDialogUi.open) this._editorDialogUi.hide()
    this._refreshResources()
  }

  /**
   * Show/hide the reviewer/admin-gated "Refresh document rules" item, and
   * re-run resource discovery so "Edit document rules" picks up the same
   * role gate applied in #doRefreshResources() (hidden entirely for a user
   * without the role, whatever the open document's resources are) - both
   * items are gated the same way so tools.js's category-label auto-hide
   * (see its module doc-comment) collapses the whole "Document rules"
   * section for a plain user, not just the refresh item.
   * @param {UserData|null} newUser
   */
  onUserChange(newUser) {
    this._refreshMenuItem.style.display = userHasRole(newUser, ['reviewer', 'admin']) ? '' : 'none'
    this._refreshResources()
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
   * parent item entirely when the current user lacks the reviewer/admin
   * role this whole "Document rules" category requires, or when no document
   * is open; shows it disabled when a document is open but references no
   * resources; shows it enabled with a populated submenu otherwise.
   * @returns {Promise<void>}
   */
  async #doRefreshResources() {
    const state = this.state
    if (!userHasRole(state.user, ['reviewer', 'admin']) || !state.xml) {
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

  /**
   * `_resources` grouped into rule categories: descriptors sharing a `group`
   * are the layers of one category (e.g. the "human" guide and the "machine"
   * rules of one interpretation-ref category); a descriptor without a group
   * is its own single-member group (keyed by its url). First-seen order.
   * @returns {Array<Array<ResourceDescriptorModel>>}
   */
  _resourceGroups() {
    /** @type {Map<string, Array<ResourceDescriptorModel>>} */
    const groups = new Map()
    for (const resource of this._resources) {
      const key = resource.group ?? resource.url
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(resource)
    }
    return [...groups.values()]
  }

  /**
   * The group (see _resourceGroups()) containing `resource`, or just
   * `[resource]` if it isn't (or no longer is) in `_resources`.
   * @param {ResourceDescriptorModel} resource
   * @returns {Array<ResourceDescriptorModel>}
   */
  _groupOf(resource) {
    return this._resourceGroups().find(group => group.includes(resource)) ?? [resource]
  }

  /**
   * Rebuild the submenu's sl-menu-item children from `_resources`, one item
   * per rule category (see _resourceGroups()) - its layers are reached via
   * the editor dialog's layer tabs, not separate menu items.
   */
  _populateSubmenu() {
    const submenu = this._editMenuItem.documentRulesEditSubmenu
    submenu.innerHTML = ''
    for (const group of this._resourceGroups()) {
      const resource = group[0]
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
   * covering both interpretation-ref <ref target> elements and the schema
   * kind's `<?xml-model href="...">` PI (see document-rules-decorations.js's
   * buildRefDecorations()). Includes each overridden resource's
   * `related_urls` so both a "human" ref and its auto-derived "machine" ref
   * (which share one resource but have different URLs) are decorated as
   * overridden together, not just the representative one; schema resources
   * have no related_urls, so this is a no-op for them.
   */
  _refreshRefDecorations() {
    const overriddenUrls = new Set()
    for (const selection of this._selections) {
      if (!selection.selected || (selection.kind !== 'interpretation-ref' && selection.kind !== 'schema')) continue
      overriddenUrls.add(selection.url)
      const resource = this._resources.find(r => r.kind === selection.kind && r.url === selection.url)
      for (const relatedUrl of resource?.related_urls ?? []) overriddenUrls.add(relatedUrl)
    }
    this._refDecorationSlot.reconfigure([
      createOverrideRefField(overriddenUrls),
      refDecorationTheme,
      createOverrideRefClickHandler((url) => this._onRefDecorationClick(url))
    ])
  }

  /**
   * Open the resource editor for the interpretation-ref or schema resource
   * matching the clicked decorated URL (a <ref target="..."> or the schema
   * kind's `<?xml-model href="...">`), looked up in the existing
   * `_resources` cache (see this plan's "Important context" on staleness).
   * An interpretation-ref entry's "human" and auto-derived "machine" refs
   * are both decorated as clickable but share one resource, so the lookup
   * also matches against `related_urls`, not just each resource's own
   * representative `url`; schema resources have no related_urls, so this
   * falls back to an exact `url` match for them. An exact `url` match wins
   * over a `related_urls` one, so the machine `<ref>` of a two-layer category
   * opens the machine layer even if the human descriptor also lists it.
   * @param {string} url
   */
  _onRefDecorationClick(url) {
    const candidates = this._resources.filter(r => r.kind === 'interpretation-ref' || r.kind === 'schema')
    const resource = candidates.find(r => r.url === url) ?? candidates.find(r => r.related_urls?.includes(url))
    if (!resource) {
      this.#logger.warn(`document-rules: no resource found for clicked ref url: ${url}`)
      return
    }
    this._openResourceEditor(resource)
  }

  /**
   * Query one resource's original text, overrides, and current selection,
   * then render and show the editor dialog for it. Also used to switch
   * between the layers of a two-layer category (see _onLayerTabShow()) -
   * the markdown/XML bodies and preview are shared across layers, so a
   * switch is a re-query and re-render of the same dialog.
   * @param {ResourceDescriptorModel} resource
   * @returns {Promise<void>}
   */
  async _openResourceEditor(resource) {
    let response
    try {
      response = await this.#client.apiClient.documentRulesQuery({ kind: resource.kind, url: resource.url })
    } catch (error) {
      notify(`Could not load resource: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      // A failed layer switch leaves the previous layer's content showing -
      // move the tab selection back to match it.
      if (this._currentResource) this._renderLayerTabs()
      return
    }
    // A layer-tab switch keeps the upstream status: it covers both layers
    const sameGroup = this._editorDialogUi.open && this._currentGroup.includes(resource)
    this._currentResource = resource
    this._currentGroup = this._groupOf(resource)
    this._renderLayerTabs()
    this._refreshSyncStatus()
    if (!sameGroup) {
      // Don't show another group's marks while this one's status loads
      this._upstreamStatus = null
      this._renderUpstreamStatus()
      this._refreshUpstreamStatus()
    }
    this._currentOverrides = response.overrides
    this._currentSelectedId = response.selected_override_id
    this._currentOriginalText = response.original_text
    // scroll: false - the dialog is still hidden (`<sl-dialog>` renders its
    // content behind a `hidden` attribute until shown, see show() below),
    // and setting scroll position on a hidden element has no effect (same
    // reason the "preview" sl-tab-show handler in install() re-scrolls once
    // its own panel becomes visible). Re-run the scroll explicitly once
    // show() resolves, i.e. once the dialog is actually visible.
    this._renderEditorDialog({ scroll: false })
    await this._editorDialogUi.show()
    if (resource.format !== 'xml') {
      // Force the "Edit" tab active before scrolling to it, rather than
      // trusting whatever tab the shared <sl-tab-group> already considers
      // active. @shoelace-style/shoelace's tab-group only auto-activates a
      // default tab via a *one-shot* IntersectionObserver that fires the
      // first time the tab group becomes visible (see its
      // connectedCallback()) - since this dialog/tab-group is created once
      // in install() while the dialog is still hidden, that callback races
      // with this method's own await above, so on the very first-ever
      // _openResourceEditor() call neither tab panel is marked "active" yet
      // by the time we get here (nothing is visible to scroll to at all).
      // Calling the tab group's own show() bypasses that race entirely and
      // also gives every freshly opened resource the same predictable
      // starting tab, instead of leaving whatever tab a *previous*
      // resource's dialog session was left on. Its "active" attribute
      // reflection (which the panel's `display: none`/`block` CSS depends
      // on) lands asynchronously with the panel's own Lit update, hence the
      // extra await.
      const tabs = this._editorDialogUi.textBody.textTabs
      tabs.show('edit')
      await tabs.editPanel.updateComplete
      this._scrollMarkdownBodyToAnchor(this._currentShownText())
    }
  }

  /**
   * Show the "Guide (human)" / "Machine rules" tabs only when
   * `_currentGroup` has more than one layer, with the tab of
   * `_currentResource`'s layer selected. Selecting it programmatically emits
   * `sl-tab-show`, which _onLayerTabShow() ignores because it names the
   * layer already shown.
   */
  _renderLayerTabs() {
    const layerTabs = this._editorDialogUi.layerTabs
    if (this._currentGroup.length < 2 || !this._currentResource.layer) {
      layerTabs.style.display = 'none'
      return
    }
    layerTabs.style.display = ''
    layerTabs.show(this._currentResource.layer)
  }

  /**
   * Show the sync status of `_currentGroup`'s human/machine layer pair below
   * the layer tabs, or hide the line when the group is not such a pair or
   * the request fails. The status describes the pair, so the line is the
   * same on both tabs. Never rejects, so callers need not await it.
   * @returns {Promise<void>}
   */
  async _refreshSyncStatus() {
    const request = ++this._syncStatusRequest
    const line = this._editorDialogUi.syncStatus
    const human = this._currentGroup.find(r => r.layer === 'human')
    const machine = this._currentGroup.find(r => r.layer === 'machine')
    // Hide another pair's status while this one loads; a layer-tab switch
    // within the same pair keeps the line, so it doesn't flicker
    const pairKey = human && machine ? human.url + '\n' + machine.url : null
    if (pairKey !== this._syncStatusPair) line.style.display = 'none'
    this._syncStatusPair = pairKey
    if (!human || !machine) {
      line.style.display = 'none'
      return
    }
    let response
    try {
      response = await this.#client.apiClient.documentRulesSyncStatus({ human_url: human.url, machine_url: machine.url })
    } catch (error) {
      if (request !== this._syncStatusRequest) return
      line.style.display = 'none'
      this.#logger.warn('document-rules: could not load sync status: ' + String(error))
      return
    }
    if (request !== this._syncStatusRequest) return
    const icon = document.createElement('sl-icon')
    icon.setAttribute('name', response.status === 'in_sync' ? 'check-circle' : 'exclamation-triangle')
    icon.style.verticalAlign = '-0.125em'
    icon.style.marginRight = '0.25rem'
    let text = SYNC_STATUS_TEXT[response.status] ?? response.status
    if (response.synced_commit) text += ` (last sync: ${response.synced_commit.slice(0, 7)})`
    line.replaceChildren(icon, document.createTextNode(text))
    line.style.display = ''
  }

  /**
   * Load the upstream status of `_currentGroup`'s overrides for an
   * interpretation-ref (whether the document's refs are behind upstream and
   * which overrides upstream now contains), then re-render the override row,
   * the status line and the buttons. Other kinds, and a failed request,
   * clear the status. Never rejects, so callers need not await it.
   * @returns {Promise<void>}
   */
  async _refreshUpstreamStatus() {
    const request = ++this._upstreamStatusRequest
    /** @type {UpstreamStatusResponse|null} */
    let status = null
    if (this._currentResource?.kind === 'interpretation-ref') {
      try {
        status = await this.#client.apiClient.documentRulesUpstreamStatus({ xml: this.state.xml, url: this._currentResource.url })
      } catch (error) {
        if (request !== this._upstreamStatusRequest) return
        this.#logger.warn('document-rules: could not load upstream status: ' + String(error))
      }
    }
    if (request !== this._upstreamStatusRequest) return
    this._upstreamStatus = status
    this._renderUpstreamStatus()
    // Not a full re-render: that would replace text being edited in the dialog
    if (this._currentResource) {
      this._renderOverrideRow()
      this._renderResetButtons()
    }
  }

  /**
   * Show `_upstreamStatus` in the line below the sync status: what upstream
   * changed, with a hint to "Update to upstream", and a line per layer that
   * could not be compared. Hidden when there is nothing to say.
   */
  _renderUpstreamStatus() {
    const line = this._editorDialogUi.upstreamStatus
    const status = this._upstreamStatus
    /** @type {HTMLElement[]} */
    const children = []
    if (status && this._upstreamActionable()) {
      const parts = []
      if (status.refs_behind) parts.push('The guide upstream has changed since this document was annotated.')
      const inUpstream = countUpstreamIds(status, 'in_upstream')
      if (inUpstream > 0) parts.push(`${pluralizeOverrides(inUpstream)} now in upstream.`)
      parts.push('Use "Update to upstream" to apply it.')
      const summary = document.createElement('div')
      const icon = document.createElement('sl-icon')
      icon.setAttribute('name', 'arrow-repeat')
      icon.style.verticalAlign = '-0.125em'
      icon.style.marginRight = '0.25rem'
      summary.append(icon, document.createTextNode(parts.join(' ')))
      children.push(summary)
    }
    for (const layer of status?.layers ?? []) {
      if (!layer.error) continue
      const errorLine = document.createElement('div')
      errorLine.textContent = `Could not compare the ${UPSTREAM_LAYER_NAME[layer.layer] ?? layer.layer} with upstream: ${layer.error}`
      children.push(errorLine)
    }
    line.replaceChildren(...children)
    line.style.display = children.length > 0 ? '' : 'none'
  }

  /**
   * Whether `_upstreamStatus` gives "Update to upstream" something to do:
   * the document's refs are behind upstream, or upstream contains overrides.
   * @returns {boolean}
   */
  _upstreamActionable() {
    const status = this._upstreamStatus
    return !!status && (status.refs_behind || countUpstreamIds(status, 'in_upstream') > 0)
  }

  /**
   * Whether upstream now contains the text of an override (in any layer of
   * the last upstream status).
   * @param {string} overrideId
   * @returns {boolean}
   */
  _inUpstream(overrideId) {
    return !!this._upstreamStatus && this._upstreamStatus.layers.some((layer) => layer.in_upstream.includes(overrideId))
  }

  /**
   * `sl-tab-show` handler of the layer tabs: open the descriptor of the
   * chosen layer in the same dialog. No-op for the layer already shown (the
   * event also fires when _renderLayerTabs() selects a tab).
   * @param {string} layer - the shown tab's panel name ("human"/"machine")
   * @returns {Promise<void>}
   */
  async _onLayerTabShow(layer) {
    if (!this._currentResource || layer === this._currentResource.layer) return
    const resource = this._currentGroup.find(r => r.layer === layer)
    if (resource) await this._openResourceEditor(resource)
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
    return this._cmMdView.state.doc.toString()
  }

  /**
   * Full re-render of the dialog for `_currentResource`/`_currentOverrides`/`_currentSelectedId`.
   * @param {{ scroll?: boolean }} [options] - `scroll: false` skips the
   *   anchor/top scroll positioning normally applied to the markdown/text
   *   body (see _scrollMarkdownBodyToAnchor()) - used by _openResourceEditor()
   *   while the dialog is still hidden, since scrolling has no effect until
   *   the dialog is actually shown.
   */
  _renderEditorDialog({ scroll = true } = {}) {
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
      this._setMarkdownContent(text, readOnly)
      dialogUi.textBody.textTabs.previewPanel.previewContent.innerHTML = this._md.render(text)
      if (scroll) this._scrollMarkdownBodyToAnchor(text)
    }

    dialogUi.newOverrideBtn.disabled = this._documentReadOnly
    dialogUi.saveBtn.style.display = selected && !this._documentReadOnly ? '' : 'none'
    dialogUi.deleteBtn.style.display = selected ? '' : 'none'
    this._renderResetButtons()
    // A pair proposes both layers together, whatever is selected; a single resource proposes its selected override
    dialogUi.proposeUpstreamBtn.style.display = (this._isPairGroup() ? !this._documentReadOnly : selected) ? '' : 'none'
    const pairedMachine = resource.layer === 'machine' && this._currentGroup.some(r => r.layer === 'human')
    dialogUi.updateFromGuideBtn.style.display = pairedMachine && !this._documentReadOnly ? '' : 'none'
  }

  /**
   * Show "Reset to original" (a selected override of a non-interpretation-ref
   * resource) or, for an interpretation-ref, "Update to upstream" (when
   * `_upstreamStatus` gives it something to do and the document is
   * editable) - an interpretation-ref is brought up to date that way instead.
   */
  _renderResetButtons() {
    const dialogUi = this._editorDialogUi
    const isRef = this._currentResource.kind === 'interpretation-ref'
    const selected = this._currentOverrides.some(o => o.id === this._currentSelectedId)
    dialogUi.resetBtn.style.display = selected && !isRef ? '' : 'none'
    dialogUi.updateToUpstreamBtn.style.display = isRef && this._upstreamActionable() && !this._documentReadOnly ? '' : 'none'
  }

  /**
   * Scroll the markdown edit view and preview to `_currentResource`'s
   * heading-anchor fragment (see headingAnchorFragment()), or reset both to
   * the top when there is none - without this, switching to a new
   * resource/override kept whatever scroll offset the previous content had
   * left behind, and a "human" ref's heading anchor (e.g.
   * "#data-correction") was never honored at all since `original_text` is
   * always the whole document for a non-line-range fragment (see
   * fetch_rule_excerpt() in annotation_rules_utils.py).
   *
   * The edit side dispatches CodeMirror's own `EditorView.scrollIntoView`
   * state effect rather than computing a pixel offset by hand
   * (`(line - 1) * lineHeight`, as a plain `<sl-textarea>` needed) - that
   * naive math assumes one source line = one visual row, which a soft-wrapped
   * textarea does not guarantee: a document with long, non-hard-wrapped
   * paragraph lines before the target heading landed the scroll position
   * thousands of pixels short of the real target. CodeMirror measures each
   * line's actual rendered (wrapped) height, so this is correct regardless of
   * wrapping - the whole reason for switching this editor to CodeMirror (see
   * _setMarkdownContent()'s doc comment).
   *
   * Also called from the "preview" `sl-tab-show` handler (with the same
   * `text`), because scrolling a hidden `display: none` tab panel has no
   * effect - the preview must already be visible for its scroll position to
   * stick; and from _openResourceEditor(), for the same reason but one level
   * up - the whole `<sl-dialog>` is still hidden while _renderEditorDialog()
   * first runs there, so that initial call passes `{ scroll: false }` and
   * this is re-invoked once the dialog's own show() has resolved.
   * @param {string} text
   */
  _scrollMarkdownBodyToAnchor(text) {
    const dialogUi = this._editorDialogUi
    const fragment = this._currentResource.format === 'markdown' ? headingAnchorFragment(this._currentResource.url) : null
    const line = fragment ? findHeadingLineForAnchor(text, fragment) : null

    const doc = this._cmMdView.state.doc
    const pos = line === null ? 0 : doc.line(Math.min(Math.max(line, 1), doc.lines)).from
    this._cmMdView.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start' }) })

    const previewContent = dialogUi.textBody.textTabs.previewPanel.previewContent
    const heading = fragment && [...previewContent.querySelectorAll('[id]')].find((el) => el.id === fragment)
    if (heading) {
      heading.scrollIntoView?.()
    } else {
      previewContent.scrollTop = 0
    }
  }

  /**
   * Human-readable label for an override id: "Original" for `null`, or
   * "Override N" (1-based, matching the order shown in the override row).
   * @param {string|null} overrideId
   * @returns {string}
   */
  _overrideLabel(overrideId) {
    if (overrideId === null) return 'Original'
    return `Override ${this._currentOverrides.findIndex(o => o.id === overrideId) + 1}`
  }

  /**
   * Rebuild the "Original"/"Override N" button row. An override whose text
   * upstream now contains (see _inUpstream()) is marked with a cloud icon,
   * otherwise one copied from an older version of the original (`outdated`,
   * see /query) with a clock icon - each with a tooltip saying so, followed
   * by the override's note if any.
   */
  _renderOverrideRow() {
    const row = this._editorDialogUi.overrideRow
    row.innerHTML = ''

    const originalBtn = document.createElement('sl-button')
    originalBtn.setAttribute('size', 'small')
    originalBtn.textContent = this._overrideLabel(null)
    originalBtn.variant = this._currentSelectedId === null ? 'primary' : 'default'
    originalBtn.addEventListener('click', () => this._selectOverride(null))
    row.appendChild(originalBtn)

    this._currentOverrides.forEach((override) => {
      const btn = document.createElement('sl-button')
      btn.setAttribute('size', 'small')
      btn.textContent = this._overrideLabel(override.id)
      btn.variant = this._currentSelectedId === override.id ? 'primary' : 'default'
      if (this._inUpstream(override.id)) {
        const icon = document.createElement('sl-icon')
        icon.setAttribute('name', 'cloud-check')
        icon.setAttribute('slot', 'suffix')
        btn.appendChild(icon)
        btn.title = override.note ? `${IN_UPSTREAM_OVERRIDE_TOOLTIP}\n${override.note}` : IN_UPSTREAM_OVERRIDE_TOOLTIP
      } else if (override.outdated) {
        const icon = document.createElement('sl-icon')
        icon.setAttribute('name', 'clock-history')
        icon.setAttribute('slot', 'suffix')
        btn.appendChild(icon)
        btn.title = override.note ? `${OUTDATED_OVERRIDE_TOOLTIP}\n${override.note}` : OUTDATED_OVERRIDE_TOOLTIP
      } else if (override.note) {
        btn.title = override.note
      }
      btn.addEventListener('click', () => this._selectOverride(override.id))
      row.appendChild(btn)
    })
  }

  /**
   * Select the original (null) or one override for `_currentResource`,
   * persisting the choice immediately - per the spec, clicking a row entry
   * "uses it immediately", it is not a staged/unsaved choice. Notifies which
   * one is now selected, for which resource, since the row's button state
   * alone is easy to miss.
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
    this._refreshSyncStatus()
    await this._refreshOverrideIndicators()
    notify(`${this._overrideLabel(overrideId)} selected for ${this._currentResource.label}.`, 'primary', 'info-circle')
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
    // A failed selection (already notified) still has to show the new override in the row
    if (this._currentSelectedId !== override.id) this._renderEditorDialog()
  }

  /**
   * Persist the currently selected override's note + shown text, rebased on
   * the shown resource's current original (clears its "outdated" marker),
   * then refresh the sync and upstream status (the saved text may now match
   * upstream or no longer do so).
   * @returns {Promise<void>}
   */
  async _onSave() {
    if (this._currentSelectedId === null || this._currentResource === null) return
    const note = this._editorDialogUi.noteInput.value
    const text = this._currentShownText()
    const fragment_url = this._currentResource.url
    let updated
    try {
      updated = await this.#client.apiClient.documentRulesUpdateOverrides(this._currentSelectedId, { note, text, fragment_url })
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
    this._refreshSyncStatus()
    this._refreshUpstreamStatus()
    notify('Override saved.', 'success', 'check-circle')
  }

  /**
   * Delete the currently selected override (owner-only, enforced server-side),
   * then refresh the sync and upstream status so the marks and counts drop it.
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
    this._refreshSyncStatus()
    this._refreshUpstreamStatus()
    await this._refreshOverrideIndicators()
  }

  /**
   * Reload this resource from its origin and permanently remove every one
   * of the caller's overrides for it - unlike selecting "Original" (see
   * _selectOverride()), which only switches away from an override without
   * deleting anything. Confirmed up front since deletion can't be undone.
   *
   * For an `interpretation-ref` resource, this also re-resolves the
   * document's own `<ref target>` to what the extractor's current rules
   * configuration would generate today - not just whatever URL is already
   * pinned, which (once SHA-pinned) can never reflect a newer upstream
   * commit on its own (see
   * docs/superpowers/specs/2026-09-29-document-rules-reset-to-original-design.md).
   * The document edit happens before override deletion, so a failure
   * updating the document leaves overrides intact. `schema` resources keep
   * the simpler delete-and-requery behavior unchanged - their URL is never
   * permalink-pinned, so there is nothing to refresh.
   *
   * Use case: the caller proposed an override's change upstream (see
   * _onProposeUpstream()) and it was accepted, so both their now-stale
   * override and the document's stale pinned URL need to be replaced by
   * this one action.
   * @returns {Promise<void>}
   */
  async _onReset() {
    const confirmed = await this.getDependency('dialog').confirm(
      'This will reload the resource from its origin and remove all overrides.',
      'Reset to original'
    )
    if (!confirmed) return

    /** @type {RefreshResourceResponse|null} */
    let refreshResult = null
    if (this._currentResource.kind === 'interpretation-ref') {
      try {
        refreshResult = await this.#client.apiClient.documentRulesRefreshResource({
          xml: this.state.xml,
          url: this._currentResource.url
        })
      } catch (error) {
        notify(`Could not refresh resource: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
        return
      }
      if (refreshResult.status !== 'ok') {
        const variant = refreshResult.status === 'not_found' ? 'danger' : 'warning'
        const icon = refreshResult.status === 'not_found' ? 'exclamation-octagon' : 'exclamation-triangle'
        notify(refreshResult.message, variant, icon)
        return
      }
      await this._applyRefreshedRefs(refreshResult)
    }

    try {
      for (const override of this._currentOverrides) {
        await this.#client.apiClient.documentRulesDeleteOverrides(override.id)
      }
    } catch (error) {
      notify(`Could not remove overrides: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }

    let response
    try {
      response = await this.#client.apiClient.documentRulesQuery({ kind: this._currentResource.kind, url: this._currentResource.url })
    } catch (error) {
      notify(`Could not reload resource: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    this._currentOverrides = response.overrides
    this._currentSelectedId = response.selected_override_id
    this._currentOriginalText = response.original_text
    this._renderEditorDialog()
    this._refreshSyncStatus()
    await this._refreshOverrideIndicators()

    const message = refreshResult
      ? (refreshResult.changed
          ? 'Reset to original: refreshed from upstream and removed all overrides.'
          : 'Reset to original: overrides removed (already up to date).')
      : `Reset to original: "${this._currentResource.label}" and its overrides have been reloaded.`
    notify(message, 'success', 'check-circle')
  }

  /**
   * Write the refreshed `<ref target>`s of a /refresh-resource result into
   * the document (saved before and after) and point `_currentGroup`'s
   * descriptors at them. No-op unless the result says the refs changed.
   * Every layer of the category is refreshed together.
   * @param {RefreshResourceResponse} refreshResult
   * @returns {Promise<void>}
   */
  async _applyRefreshedRefs(refreshResult) {
    if (refreshResult.changed) {
      // Every layer of the category is refreshed together, so match the
      // document's <ref>s against all layers' urls, not just the shown one's
      const group = this._currentGroup.includes(this._currentResource) ? this._currentGroup : [this._currentResource]
      const groupUrls = new Set(group.flatMap((r) => [r.url, ...(r.related_urls ?? [])]))
      /** @type {Map<string, string>} old target -> refreshed target */
      const replacedUrls = new Map()
      await this.#xmlEditor.saveIfDirty()
      for (const ref of refreshResult.refs) {
        const candidates = this.#xmlEditor.getDomNodesByXpath(`//tei:editorialDecl//tei:ref[@subtype="${ref.subtype}"]`)
        const node = candidates.find((n) => groupUrls.has(n.getAttribute('target')))
        if (!node) continue
        replacedUrls.set(node.getAttribute('target'), ref.target)
        node.setAttribute('target', ref.target)
        await this.#xmlEditor.updateEditorFromNode(node)
      }
      await this.#xmlEditor.saveIfDirty()

      if (refreshResult.refs.length > 0) {
        for (const member of group) {
          // A layerless descriptor keeps representative_ref()'s choice
          // (interpretation_ref_kind.py): the machine ref when present
          const layer = member.layer ?? 'machine'
          const ref = refreshResult.refs.find((r) => r.subtype === layer) ?? (member.layer ? null : refreshResult.refs[0])
          if (ref) member.url = ref.target
          if (member.related_urls) member.related_urls = member.related_urls.map((u) => replacedUrls.get(u) ?? u)
        }
      }
    }
  }

  /**
   * "Update to upstream" of an interpretation-ref: re-pin the document's refs
   * of `_currentGroup` to the current upstream rules, then remove the
   * caller's overrides whose text upstream now contains - the server checks
   * that again on removal, so only what it confirms is deleted. Other
   * overrides are kept. Confirmed up front, with the counts of the last
   * upstream status.
   * @returns {Promise<void>}
   */
  async _onUpdateToUpstream() {
    const inUpstream = countUpstreamIds(this._upstreamStatus, 'in_upstream')
    const kept = countUpstreamIds(this._upstreamStatus, 'kept')
    let text = 'This updates the document to the current upstream rules'
    text += inUpstream > 0 ? ` and removes ${pluralizeOverrides(inUpstream)} that upstream now contains.` : '.'
    if (kept > 0) text += ` ${kept} other ${kept === 1 ? 'override is' : 'overrides are'} kept.`
    const confirmed = await this.getDependency('dialog').confirm(text, 'Update to upstream')
    if (!confirmed) return

    const btn = this._editorDialogUi.updateToUpstreamBtn
    btn.disabled = true
    btn.loading = true
    try {
      await this._updateToUpstream()
    } finally {
      btn.disabled = false
      btn.loading = false
    }
  }

  /**
   * The work of _onUpdateToUpstream() after its confirmation.
   * @returns {Promise<void>}
   */
  async _updateToUpstream() {
    /** @type {RefreshResourceResponse} */
    let refreshResult
    try {
      refreshResult = await this.#client.apiClient.documentRulesRefreshResource({
        xml: this.state.xml,
        url: this._currentResource.url
      })
    } catch (error) {
      notify(`Could not refresh resource: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    if (refreshResult.status !== 'ok') {
      const variant = refreshResult.status === 'not_found' ? 'danger' : 'warning'
      const icon = refreshResult.status === 'not_found' ? 'exclamation-octagon' : 'exclamation-triangle'
      notify(refreshResult.message, variant, icon)
      return
    }
    await this._applyRefreshedRefs(refreshResult)

    /** @type {UpstreamStatusResponse|null} */
    let removal = null
    try {
      // The url after the re-pin, so the server compares with the refs now in the document
      removal = await this.#client.apiClient.documentRulesRemoveOverridesInUpstream({
        xml: this.state.xml,
        url: this._currentResource.url
      })
    } catch (error) {
      notify(`Could not remove overrides: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
    }

    let response
    try {
      response = await this.#client.apiClient.documentRulesQuery({ kind: this._currentResource.kind, url: this._currentResource.url })
    } catch (error) {
      notify(`Could not reload resource: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    this._currentOverrides = response.overrides
    this._currentSelectedId = response.selected_override_id
    this._currentOriginalText = response.original_text
    this._renderEditorDialog()
    this._refreshSyncStatus()
    this._refreshUpstreamStatus()
    await this._refreshOverrideIndicators()

    if (removal) {
      const removed = countUpstreamIds(removal, 'in_upstream')
      notify(`Updated to upstream: removed ${pluralizeOverrides(removed)}, kept ${countUpstreamIds(removal, 'kept')}.`, 'success', 'check-circle')
    }
  }

  /**
   * Build a URL that lets the caller's own GitHub/GitLab session propose the
   * currently shown override text as the resource's new upstream content,
   * explain in a confirm dialog what will happen (a toast fired right before
   * window.open() loses the race against the new tab stealing focus, so the
   * explanation has to come first, not after), then on confirmation copy the
   * text to the clipboard as a paste-ready fallback (GitLab, and GitHub when
   * the text is too long to embed in the URL, can't prefill the content) and
   * open the forge's page in a new tab. No server-side git write happens
   * anywhere in this flow - see
   * docs/superpowers/specs/2026-09-28-document-rules-propose-upstream-design.md.
   * @returns {Promise<void>}
   */
  async _onProposeUpstream() {
    const text = this._currentShownText()
    let response
    try {
      response = await this.#client.apiClient.documentRulesProposeChangeUrl({ url: this._currentResource.url, text })
    } catch (error) {
      notify(`Could not build the upstream link: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    if (!response.url) {
      notify('This resource is not hosted on a recognized git forge; no upstream link is available.', 'warning', 'exclamation-triangle')
      return
    }
    const message = response.content_prefilled
      ? 'This opens a new tab with the upstream editor, prefilled with your override text.'
      : 'This copies your override text to the clipboard and opens the upstream editor in a new tab. Paste the copied text into the file once it opens.'
    const confirmed = await this.getDependency('dialog').confirm(message, 'Propose change upstream')
    if (!confirmed) return

    try {
      // response.text, not the local `text` - the backend rewrites same-repo
      // absolute links (this app's own internal resolution of the
      // resource's original relative links) back to their upstream-relative
      // form first, so the clipboard doesn't paste this app's internal
      // link representation into the real file.
      await navigator.clipboard.writeText(response.text)
    } catch {
      // Clipboard denied/unavailable - non-fatal whether or not the URL
      // itself already carries the text.
    }
    window.open(response.url, '_blank', 'noopener')
  }

  /**
   * The human and machine descriptor of `_currentGroup`, each null when the
   * group has no such layer.
   * @returns {{ human: ResourceDescriptorModel|null, machine: ResourceDescriptorModel|null }}
   */
  _currentPair() {
    return {
      human: this._currentGroup.find(r => r.layer === 'human') ?? null,
      machine: this._currentGroup.find(r => r.layer === 'machine') ?? null
    }
  }

  /**
   * Whether `_currentGroup` is a human/machine layer pair.
   * @returns {boolean}
   */
  _isPairGroup() {
    const { human, machine } = this._currentPair()
    return human !== null && machine !== null
  }

  /**
   * Click handler of the editor dialog's "Propose upstream" button: a
   * human/machine pair is proposed as one patch in the propose sub-dialog,
   * any other resource through the forge's web editor.
   * @returns {Promise<void>}
   */
  async _onProposeUpstreamClick() {
    if (this._isPairGroup()) {
      await this._openProposeDialog()
    } else {
      await this._onProposeUpstream()
    }
  }

  /**
   * Wire the propose sub-dialog's checkboxes and buttons, and reset it when
   * it closes.
   */
  _installProposeDialogListeners() {
    const ui = this._proposeDialogUi
    const refresh = () => { this._proposalPromise = this._refreshProposalSafely() }
    ui.includeHuman.addEventListener('sl-change', refresh)
    ui.includeMachine.addEventListener('sl-change', refresh)
    ui.prSection.prTitle.addEventListener('sl-input', () => { this._prTitleEdited = true })
    ui.prSection.prBody.addEventListener('sl-input', () => { this._prBodyEdited = true })
    ui.createPrBtn.addEventListener('click', () => this._onCreatePullRequest())
    ui.downloadBtn.addEventListener('click', () => this._onDownloadPatch())
    ui.closeBtn.addEventListener('click', () => ui.hide())
    ui.addEventListener('sl-after-hide', (event) => {
      // Nested Shoelace components may emit their own sl-after-hide
      if (event.target === ui) this._resetProposeDialog()
    })
  }

  /**
   * Whether the user has selected an override of `resource`. The shown
   * layer's selection is read from the editor dialog, the other layer's
   * from `_selections`.
   * @param {ResourceDescriptorModel} resource
   * @returns {boolean}
   */
  _hasSelectedOverride(resource) {
    if (resource === this._currentResource) return this._currentSelectedId !== null
    return this._selections.some(s => s.kind === resource.kind && s.url === resource.url && s.selected)
  }

  /**
   * Open the "Propose upstream" sub-dialog for `_currentGroup`'s
   * human/machine pair, with each layer that has a selected override
   * included (the shown layer if neither has one), and load the proposal.
   * @returns {Promise<void>}
   */
  async _openProposeDialog() {
    const { human, machine } = this._currentPair()
    if (!human || !machine) return
    const ui = this._proposeDialogUi
    this._resetProposeDialog()
    let includeHuman = this._hasSelectedOverride(human)
    let includeMachine = this._hasSelectedOverride(machine)
    if (!includeHuman && !includeMachine) {
      includeHuman = this._currentResource === human
      includeMachine = this._currentResource === machine
    }
    ui.includeHuman.checked = includeHuman
    ui.includeMachine.checked = includeMachine
    this._proposalPromise = this._refreshProposalSafely()
    await ui.show()
    await this._proposalPromise
  }

  /**
   * Whether the editor shows text that differs from the shown layer's
   * selected override, i.e. edits that are not saved and so are not part
   * of a proposal, which is built from the stored texts. Without a selected
   * override the editor is read-only and shows the original.
   * @returns {boolean}
   */
  _hasUnsavedEdits() {
    const selected = this._currentOverrides.find(o => o.id === this._currentSelectedId) ?? null
    return selected !== null && this._currentShownText() !== selected.text
  }

  /**
   * _refreshProposal() for event handlers: an unexpected error is logged
   * and shown in the notice instead of becoming an unhandled rejection.
   * @returns {Promise<void>}
   */
  async _refreshProposalSafely() {
    try {
      await this._refreshProposal()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#logger.warn('document-rules: could not show the upstream proposal: ' + message)
      this._setProposeNotices([message])
    }
  }

  /**
   * Request the patch for the layers checked in the propose sub-dialog
   * (POST /document-rules/propose-patch) and show one diff per changed
   * file, with notices on unsaved editor edits (not included), sections
   * changed upstream (replaced by the patch), and what the proposal does to
   * the sync status. For a guide on GitHub the pull request controls are
   * shown, with the default title and description unless the user edited
   * them. The previous diffs are cleared and download and pull request
   * creation are disabled while the request is pending. An error (e.g.
   * nothing selected, nothing to change, a fetch failure) is shown in the
   * notice instead of the files. Only the latest call's response is shown,
   * and none after the sub-dialog was reset.
   * @returns {Promise<void>}
   */
  async _refreshProposal() {
    const { human, machine } = this._currentPair()
    if (!human || !machine) return
    const ui = this._proposeDialogUi
    const session = ++this._proposalSession
    const includeHuman = ui.includeHuman.checked
    const includeMachine = ui.includeMachine.checked
    const unsavedNotices = this._hasUnsavedEdits() ? [UNSAVED_PROPOSAL_NOTICE] : []
    // No stale diffs while the request is pending
    this._clearProposal()
    this._setProposeNotices(unsavedNotices)
    /** @type {ProposePatchResponse} */
    let response
    try {
      response = await this.#client.apiClient.documentRulesProposePatch({
        human_url: human.url,
        machine_url: machine.url,
        include_human: includeHuman,
        include_machine: includeMachine,
        label: human.label
      })
    } catch (error) {
      if (session !== this._proposalSession) return
      this._clearProposal()
      this._setProposeNotices([...unsavedNotices, error instanceof Error ? error.message : String(error)])
      return
    }
    if (session !== this._proposalSession) return
    this._clearProposal()
    this._proposal = response
    for (const file of response.files) {
      const heading = document.createElement('div')
      heading.dataset.role = 'path'
      heading.textContent = file.path
      heading.style.fontWeight = 'var(--sl-font-weight-semibold)'
      heading.style.marginBottom = '0.25rem'
      const diff = document.createElement('div')
      diff.style.border = '1px solid var(--sl-color-neutral-300)'
      diff.style.marginBottom = '0.75rem'
      ui.files.append(heading, diff)
      this._proposalViews.push(this._createMergeView(diff, file.before, file.after))
    }
    const notices = [...unsavedNotices, ...response.upstream_changed.map(upstreamChangedNotice)]
    if (includeMachine) {
      notices.push(response.in_sync ? MACHINE_PROPOSAL_NOTICE : MACHINE_OUTDATED_PROPOSAL_NOTICE)
    } else if (includeHuman) {
      notices.push(GUIDE_ONLY_PROPOSAL_NOTICE)
    }
    this._setProposeNotices(notices)
    ui.downloadBtn.disabled = false
    const canOpen = response.can_open_pull_request
    ui.prSection.style.display = canOpen ? '' : 'none'
    ui.createPrBtn.style.display = canOpen ? '' : 'none'
    // No second pull request while one is created or after it was, until the dialog is reopened
    ui.createPrBtn.disabled = !canOpen || this._pullRequestPending || this._pullRequestCreated
    ui.prSection.prTarget.textContent = canOpen ? `The pull request will be opened on ${response.pull_request_repository}.` : ''
    // Texts the user edited since the dialog opened are kept
    if (!this._prTitleEdited) ui.prSection.prTitle.value = response.pull_request_title
    if (!this._prBodyEdited) ui.prSection.prBody.value = response.pull_request_body
  }

  /**
   * Show `notices` in the propose sub-dialog's notice area, one per line,
   * or hide it when there are none.
   * @param {Array<string>} notices
   */
  _setProposeNotices(notices) {
    const notice = this._proposeDialogUi.notice
    notice.replaceChildren(...notices.map((text) => {
      const line = document.createElement('div')
      line.textContent = text
      return line
    }))
    notice.style.display = notices.length > 0 ? '' : 'none'
  }

  /**
   * Destroy the propose sub-dialog's merge views and drop its proposal.
   */
  _clearProposal() {
    for (const view of this._proposalViews) view.destroy()
    this._proposalViews = []
    this._proposal = null
    this._proposeDialogUi.files.replaceChildren()
    this._proposeDialogUi.downloadBtn.disabled = true
    this._proposeDialogUi.createPrBtn.disabled = true
  }

  /**
   * Clear the propose sub-dialog, hide its pull request controls, forget
   * the user's edits of the pull request texts and invalidate any pending
   * request.
   */
  _resetProposeDialog() {
    const ui = this._proposeDialogUi
    this._proposalSession++
    this._pullRequestSession++
    this._clearProposal()
    this._setProposeNotices([])
    ui.prSection.style.display = 'none'
    ui.createPrBtn.style.display = 'none'
    ui.prSection.prTarget.textContent = ''
    ui.prSection.prResult.replaceChildren()
    ui.createPrBtn.loading = false
    this._prTitleEdited = false
    this._prBodyEdited = false
    this._pullRequestPending = false
    this._pullRequestCreated = false
  }

  /**
   * Open a GitHub pull request with the shown proposal
   * (POST /document-rules/propose-pull-request), with the title and
   * description from the sub-dialog and the previewed files' base hashes,
   * so that the server refuses it if the guide changed upstream since the
   * preview. A missing GitHub token is asked for and the request retried.
   * The button shows a spinner while the request runs. On success the pull
   * request's number and link are shown and the button stays disabled
   * until the sub-dialog is reset, also across refreshes, so that no
   * duplicate is opened; on an error its message is shown and the button
   * enabled again. A pull request created after the sub-dialog was reset
   * or closed is reported in a notification.
   * @returns {Promise<void>}
   */
  async _onCreatePullRequest() {
    const { human, machine } = this._currentPair()
    if (!human || !machine || !this._proposal) return
    const ui = this._proposeDialogUi
    const result = ui.prSection.prResult
    const session = this._pullRequestSession
    const baseHashes = this._proposal.base_hashes
    ui.createPrBtn.disabled = true
    ui.createPrBtn.loading = true
    this._pullRequestPending = true
    result.replaceChildren()
    /** @type {ProposePullRequestResponse} */
    let response
    try {
      response = await this.getDependency('api-keys').withKeyPrompt(
        () => this.#client.apiClient.documentRulesProposePullRequest({
          human_url: human.url,
          machine_url: machine.url,
          include_human: ui.includeHuman.checked,
          include_machine: ui.includeMachine.checked,
          label: human.label,
          title: ui.prSection.prTitle.value,
          body: ui.prSection.prBody.value,
          base_hashes: baseHashes
        })
      )
    } catch (error) {
      if (session !== this._pullRequestSession) return
      ui.createPrBtn.loading = false
      this._pullRequestPending = false
      result.textContent = error instanceof Error ? error.message : String(error)
      // Enabled only if a proposal is shown, not while a refresh is pending
      ui.createPrBtn.disabled = this._proposal === null || !this._proposal.can_open_pull_request
      return
    }
    if (session !== this._pullRequestSession) {
      // Created on GitHub although the sub-dialog was reset or closed meanwhile
      notify(`Pull request #${response.number} created: ${response.url}`, 'success', 'check-circle')
      return
    }
    ui.createPrBtn.loading = false
    this._pullRequestPending = false
    this._pullRequestCreated = true
    const link = document.createElement('a')
    link.href = response.url
    link.target = '_blank'
    link.rel = 'noopener'
    link.textContent = 'Open on GitHub'
    const created = response.fork
      ? `Pull request #${response.number} created from your fork ${response.fork}. `
      : `Pull request #${response.number} created. `
    result.append(created, link)
  }

  /**
   * Download the shown proposal's patch under its proposed file name.
   */
  _onDownloadPatch() {
    if (!this._proposal) return
    const blob = new Blob([this._proposal.patch], { type: 'text/x-diff' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = this._proposal.filename
    a.click()
    URL.revokeObjectURL(url)
  }

  /**
   * Open the "Update machine rules from guide" sub-dialog for
   * `_currentGroup`'s human/machine pair: show how the guide section changed
   * since the last sync (POST /document-rules/human-change) and offer the
   * available models for generating updated machine rules. The button
   * shows as loading meanwhile and ignores further clicks; the sub-dialog
   * is not opened if, by the time the change arrives, the editor dialog was
   * closed, shows another rule category, or a newer request started.
   * Warns if the machine layer's selected override was itself accepted
   * from this dialog, since the sync marker stays unchanged until the
   * change is proposed upstream.
   * @returns {Promise<void>}
   */
  async _openUpdateDialog() {
    const { human, machine } = this._currentPair()
    const btn = this._editorDialogUi.updateFromGuideBtn
    if (!human || !machine || btn.loading) return
    // The overrides and selection are those of the shown layer, which is the machine layer when the button is clicked
    const selectedMachineOverride = this._currentResource === machine
      ? this._currentOverrides.find(o => o.id === this._currentSelectedId) ?? null
      : null
    const request = ++this._updateDialogOpenRequest
    btn.loading = true
    btn.disabled = true
    /** @type {HumanChangeResponse} */
    let change
    try {
      change = await this.#client.apiClient.documentRulesHumanChange({ human_url: human.url, machine_url: machine.url })
    } catch (error) {
      notify(`Could not load the guide change: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    } finally {
      btn.loading = false
      btn.disabled = false
    }
    if (request !== this._updateDialogOpenRequest || !this._editorDialogUi.open || !this._currentGroup.some(r => r.layer === 'machine' && r.url === machine.url)) return
    const ui = this._updateDialogUi
    this._resetUpdateDialog()
    this._humanDiffView = this._createMergeView(ui.humanDiff, change.old_human ?? '', change.new_human)

    this._updateModels = this.#inferenceSettings.getModels()
    const notices = []
    if (change.mode === 'align') {
      notices.push(ALIGN_MODE_NOTICE)
    } else if (change.unchanged) {
      notices.push(UNCHANGED_GUIDE_NOTICE)
    }
    if (selectedMachineOverride?.note.startsWith(UPDATED_FROM_GUIDE_NOTE_PREFIX)) notices.push(REPEATED_UPDATE_NOTICE)
    if (this._updateModels.length === 0) notices.push(NO_MODEL_NOTICE)
    ui.notice.replaceChildren(...notices.map((text) => {
      const line = document.createElement('div')
      line.textContent = text
      return line
    }))
    ui.notice.style.display = notices.length > 0 ? '' : 'none'
    this._renderModelPicker()
    await ui.show()
  }

  /**
   * Fill the sub-dialog's model picker from `_updateModels`, preselecting
   * inference-settings' default model (else the first one), or hide the
   * picker when there is no model.
   */
  _renderModelPicker() {
    const modelRow = this._updateDialogUi.modelRow
    const preferred = this.#inferenceSettings.getDefaultModel()
    modelRow.modelSelect.replaceChildren(...this._updateModels.map((model, index) => {
      const option = document.createElement('sl-option')
      option.value = String(index)
      option.textContent = model.label
      return option
    }))
    const preferredIndex = preferred
      ? this._updateModels.findIndex(m => m.providerId === preferred.providerId && m.modelId === preferred.modelId)
      : -1
    modelRow.modelSelect.value = this._updateModels.length > 0 ? String(Math.max(preferredIndex, 0)) : ''
    modelRow.style.display = this._updateModels.length > 0 ? '' : 'none'
  }

  /**
   * The model chosen in the sub-dialog's picker, or null if none is.
   * @returns {ModelChoice|null}
   */
  _selectedUpdateModel() {
    const value = this._updateDialogUi.modelRow.modelSelect.value
    return typeof value === 'string' && value !== '' ? this._updateModels[Number(value)] ?? null : null
  }

  /**
   * Ask the selected model for machine rules updated to the guide change
   * (POST /document-rules/update-from-guide) and show them as a diff against
   * the current machine rules. If the provider needs an API key the user
   * has not stored, asks for it and retries. A response or error that arrives after the
   * sub-dialog was closed or reopened is dropped, leaving the new session's
   * buttons alone (_resetUpdateDialog() has already reset them).
   * @returns {Promise<void>}
   */
  async _onGenerate() {
    const { human, machine } = this._currentPair()
    const model = this._selectedUpdateModel()
    if (!human || !machine || !model) return
    const session = this._updateDialogSession
    const generateBtn = this._updateDialogUi.modelRow.generateBtn
    generateBtn.disabled = true
    generateBtn.loading = true
    let response
    try {
      response = await this.getDependency('api-keys').withKeyPrompt(
        () => this.#client.apiClient.documentRulesUpdateFromGuide({
          xml: this.state.xml,
          human_url: human.url,
          machine_url: machine.url,
          provider_id: model.providerId,
          model_id: model.modelId
        })
      )
    } catch (error) {
      if (session !== this._updateDialogSession) return
      generateBtn.disabled = false
      generateBtn.loading = false
      notify(`Could not update the machine rules: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    if (session !== this._updateDialogSession) return
    generateBtn.disabled = false
    generateBtn.loading = false
    const ui = this._updateDialogUi
    this._proposedDiffView?.destroy()
    this._proposedDiffView = this._createMergeView(ui.proposedDiff, response.machine, response.proposed)
    this._proposedMachineText = response.proposed
    this._proposedModel = model
    ui.proposedHeading.style.display = ''
    ui.proposedDiff.style.display = ''
    ui.acceptBtn.style.display = ''
    ui.acceptBtn.disabled = false
  }

  /**
   * Save the proposed machine rules as a new override of the machine layer,
   * note naming the model that generated them, select it (switching the
   * editor dialog to the machine layer first if needed) and close the
   * sub-dialog. Accept and Generate stay disabled while the override is
   * created, so a double click cannot create it twice; once it exists, the
   * proposal is dropped and the sub-dialog closes even if the layer switch
   * or the selection fails.
   * @returns {Promise<void>}
   */
  async _onAcceptProposal() {
    const { machine } = this._currentPair()
    const ui = this._updateDialogUi
    if (!machine || ui.acceptBtn.disabled || this._proposedMachineText === null || this._proposedModel === null) return
    const modelLabel = this.#inferenceSettings.getModelLabel(this._proposedModel.providerId, this._proposedModel.modelId)
    ui.acceptBtn.disabled = true
    ui.acceptBtn.loading = true
    ui.modelRow.generateBtn.disabled = true
    let override
    try {
      override = await this.#client.apiClient.documentRulesOverrides({
        kind: machine.kind,
        fragment_url: machine.url,
        note: UPDATED_FROM_GUIDE_NOTE_PREFIX + modelLabel,
        text: this._proposedMachineText
      })
    } catch (error) {
      ui.acceptBtn.disabled = false
      ui.acceptBtn.loading = false
      ui.modelRow.generateBtn.disabled = false
      notify(`Could not create override: ${error instanceof Error ? error.message : error}`, 'danger', 'exclamation-octagon')
      return
    }
    ui.acceptBtn.loading = false
    this._proposedMachineText = null
    this._proposedModel = null
    if (this._currentResource !== machine) {
      await this._openResourceEditor(machine)
      // _openResourceEditor() has already notified a failed switch
      if (this._currentResource !== machine) {
        await ui.hide()
        return
      }
    }
    // A layer switch re-queried the overrides, which then already list this one
    if (!this._currentOverrides.some(o => o.id === override.id)) this._currentOverrides.push(override)
    await this._selectOverride(override.id)
    // A failed selection (already notified) still has to show the new override in the row
    if (this._currentSelectedId !== override.id) this._renderEditorDialog()
    await ui.hide()
  }

  /**
   * Destroy the sub-dialog's merge views, drop its proposal and invalidate
   * any pending Generate request.
   */
  _resetUpdateDialog() {
    this._updateDialogSession++
    this._humanDiffView?.destroy()
    this._proposedDiffView?.destroy()
    this._humanDiffView = null
    this._proposedDiffView = null
    this._proposedMachineText = null
    this._proposedModel = null
    const ui = this._updateDialogUi
    ui.proposedHeading.style.display = 'none'
    ui.proposedDiff.style.display = 'none'
    // Shown once Generate has produced machine rules to accept
    ui.acceptBtn.style.display = 'none'
    ui.acceptBtn.disabled = true
    ui.acceptBtn.loading = false
    ui.modelRow.generateBtn.disabled = false
    ui.modelRow.generateBtn.loading = false
  }

  /**
   * A read-only markdown CodeMirror view in `parent` showing `modified`,
   * with the changes from `original` highlighted inline and unchanged
   * stretches collapsed (expandable by click) to three lines of context.
   * @param {HTMLElement} parent
   * @param {string} original
   * @param {string} modified
   * @returns {EditorView}
   */
  _createMergeView(parent, original, modified) {
    return new EditorView({
      state: EditorState.create({
        doc: modified,
        extensions: [
          markdownLanguage(),
          EditorView.lineWrapping,
          EditorView.theme({ '&': { maxHeight: '20rem' }, '.cm-scroller': { overflow: 'auto' } }),
          getTheme(this._editorThemeId()).extensions,
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          unifiedMergeView({ original, mergeControls: false, collapseUnchanged: { margin: 3, minSize: 4 } })
        ]
      }),
      parent
    })
  }

  /**
   * The user's own XML-editor theme choice. `this.uiStorage` is namespaced
   * by THIS plugin's own name ('document-rules'), which is not where
   * xmleditor.js's plugin ('xmleditor') persists the setting - it must be
   * read from that plugin's own namespace instead.
   * @returns {string}
   */
  _editorThemeId() {
    return this.context.getUIStorage('xmleditor').get('editorTheme', 'default')
  }

  /**
   * Replace the CodeMirror doc's full content, toggle its read-only
   * compartment (both the DOM-level EditorView.editable and the
   * command-level EditorState.readOnly facet - the latter is what actually
   * makes CodeMirror's own undo/redo refuse to run while read-only; toggling
   * only `editable` leaves Ctrl+Z/Ctrl+Y still active), and clear undo/redo
   * history so a previous resource's/override's content can never resurface
   * via undo in what's now showing a different one. Mirrors
   * app/src/modules/xmleditor.js's setReadOnly() and clearHistory(). Also
   * resets the scroll position to the top - without this, switching to a
   * new resource/override kept whatever scroll offset the previous, longer
   * or shorter, document had left behind.
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
    this._cmView.scrollDOM.scrollTop = 0
  }

  /** @returns {string} */
  _currentXmlText() {
    return this._cmView.state.doc.toString()
  }

  /**
   * Replace `_cmMdView`'s full content and toggle read-only/history exactly
   * like _setXmlContent() does for the XML CodeMirror instance - see that
   * method's doc comment for why each step is needed. This editor replaced a
   * plain `<sl-textarea>` because a textarea has no reliable way to scroll to
   * a specific source line once its content soft-wraps: the previous
   * approach approximated the target's pixel offset as
   * `(line - 1) * lineHeight`, which assumes one source line = one visual
   * row - wrong for any document with long, non-hard-wrapped paragraph
   * lines, landing the scroll thousands of pixels short of a heading anchor
   * deep in a real annotation guide. CodeMirror measures each line's actual
   * rendered height itself (see _scrollMarkdownBodyToAnchor()'s use of
   * `EditorView.scrollIntoView`), so it doesn't need that approximation.
   * @param {string} text
   * @param {boolean} readOnly
   */
  _setMarkdownContent(text, readOnly) {
    this._cmMdView.dispatch({
      changes: { from: 0, to: this._cmMdView.state.doc.length, insert: text },
      effects: [
        this._cmMdReadOnlyCompartment.reconfigure([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]),
        this._cmMdHistoryCompartment.reconfigure([])
      ]
    })
    this._cmMdView.dispatch({ effects: this._cmMdHistoryCompartment.reconfigure(history()) })
    this._cmMdView.scrollDOM.scrollTop = 0
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
