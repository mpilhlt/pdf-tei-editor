/**
 * The merge view plugin: compares the open document with another version of it in the XML editor's
 * merge (diff) view. It owns the whole feature at plugin level:
 *
 * - the "Compare with version" selectbox in the main toolbar,
 * - showing and hiding the merge view (`ep.mergeView.show` / `ep.mergeView.hide`), including the
 *   `diff` state, the URL hash and switching validation off while the merge view is shown,
 * - the diff navigation, reject/accept-all and strict-diff buttons in the left section of the XML
 *   editor toolbar,
 * - ending the merge view with Esc.
 *
 * Other plugins only invoke the extension points, so the application works without this plugin. The
 * diff itself is computed and rendered by the XML editor (`XMLEditor#showMergeView()`).
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { PanelContribution } from '../modules/panels/base-panel.js'
 * @import { SlSelect, SlOption } from '../ui.js'
 * @import { StatusButton } from '../modules/panels/widgets/status-button.js'
 * @import { StatusToggleButton } from '../modules/panels/widgets/status-toggle-button.js'
 */

import ui, { updateUi } from '../ui.js'
import Plugin from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import { registerTemplate, createFromTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { XMLEditor } from '../modules/xmleditor.js'
import { UrlHash } from '../modules/browser-utils.js'
import { filterFileData, getSelectedFileVersions, appendVersionOptions } from '../modules/version-options.js'

await registerTemplate('merge-view-toolbar', 'merge-view-toolbar.html')
await registerTemplate('merge-view-selector', 'merge-view-selector.html')

/**
 * The merge view widgets in the XML editor toolbar (`ui.xmlEditor.toolbar`)
 * @typedef {object} mergeViewToolbarPart
 * @property {StatusButton} prevDiffBtn - Previous diff button
 * @property {StatusButton} nextDiffBtn - Next diff button
 * @property {StatusButton} rejectAllBtn - Reject all changes button
 * @property {StatusButton} acceptAllBtn - Accept all changes button
 * @property {StatusToggleButton} strictDiffToggle - Strict diff toggle (whitespace and linebreaks significant in merge view diff)
 */

/**
 * Overflow priority of the XML editor toolbar widgets, in template order (also their order in the
 * section): prevDiff, nextDiff, separator, rejectAll, acceptAll, separator, strictDiff
 */
const TOOLBAR_PRIORITIES = [103, 102, 101, 100, 99, 98, 97]

/** Elements that show the merge view as active (highlighted) and are only enabled in an editable document */
const DIFF_BUTTON_NAMES = /** @type {const} */ (['prevDiffBtn', 'nextDiffBtn', 'rejectAllBtn', 'acceptAllBtn'])

/** State keys after which the versions listed in the "Compare with version" selectbox change */
const VERSION_LIST_KEYS = ['xml', 'pdf', 'variant', 'fileData', 'collectionFilter', 'projects']

class MergeViewPlugin extends Plugin {
  static extensionPoints = [ep.mergeView.show, ep.mergeView.hide, ep.toolbar.contentItems, ep.filedata.loading];

  /**
   * Extension point handler for `ep.mergeView.show`.
   * Called by plugins that open a comparison with another version (e.g. the start plugin for a `diff`
   * in the URL, the backend plugin sandbox).
   * Delegates to {@link MergeViewPlugin#show}.
   * @param {string} diff - The stable id of the version to compare with
   * @returns {Promise<void>}
   */
  [ep.mergeView.show](diff) { return this.show(diff) }

  /**
   * Extension point handler for `ep.mergeView.hide`.
   * Called by plugins before they change or replace the open document (e.g. services, file-selection,
   * document-actions, diagnostics-drawer).
   * Delegates to {@link MergeViewPlugin#hide}.
   * @returns {Promise<void>}
   */
  [ep.mergeView.hide]() { return this.hide() }

  /**
   * Extension point handler for `ep.toolbar.contentItems`.
   * Called by ToolbarPlugin during start() to collect the toolbar contributions. Returns the "Compare
   * with version" selectbox, right of the file-selection controls (order 11-14) and left of the
   * Document actions (order 8).
   * Delegates to {@link MergeViewPlugin#getToolbarContentItems}.
   * @returns {PanelContribution[]}
   */
  [ep.toolbar.contentItems]() { return this.getToolbarContentItems() }

  /**
   * Extension point handler for `ep.filedata.loading`.
   * Called by the filedata plugin when loading the file data starts or ends, so that the selectbox
   * is disabled meanwhile and repopulated afterwards.
   * Delegates to {@link MergeViewPlugin#loading}.
   * @param {boolean} isLoading
   * @returns {void}
   */
  [ep.filedata.loading](isLoading) { return this.loading(isLoading) }

  /** @param {PluginContext} context */
  constructor(context) {
    super(context, {
      name: 'merge-view',
      deps: ['xmleditor', 'logger']
    })
  }

  get #xmlEditor() { return this.getDependency('xmleditor') }
  get #logger() { return this.getDependency('logger') }

  /** Whether the merge view is currently shown, independent of the read-only state */
  #mergeViewActive = false

  /** @type {SlSelect} The "Compare with version" selectbox */
  #select

  /** Whether the selectbox was opened by the user; gates sl-change handling */
  #userOpenedSelect = false

  #isFileLoading = false

  /** @param {ApplicationState} initialState */
  async install(initialState) {
    await super.install(initialState)
    this.#logger.debug(`Installing plugin "${this.name}"`)

    this.#select = /** @type {SlSelect} */ (createSingleFromTemplate('merge-view-selector'))
    this.#installSelectHandlers()

    const xmlEditor = this.#xmlEditor
    let index = 0
    for (const element of createFromTemplate('merge-view-toolbar')) {
      if (!(element instanceof HTMLElement)) continue
      if (element instanceof HTMLStyleElement) {
        document.head.appendChild(element)
        continue
      }
      const priority = TOOLBAR_PRIORITIES[index++] ?? 1
      xmlEditor.addToolbarWidget(element, priority, 'left', priority)
    }
    updateUi()

    const toolbar = ui.xmlEditor.toolbar

    // Initialize strict-diff toggle from stored preference
    const strictDiff = this.#getStrictDiffPreference()
    toolbar.strictDiffToggle.checked = strictDiff
    xmlEditor.setIgnoreWhitespaceInDiff(!strictDiff)
    toolbar.strictDiffToggle.addEventListener('widget-change', (e) => {
      const strict = /** @type {CustomEvent} */ (e).detail.checked
      this.#setStrictDiffPreference(strict)
      this.#xmlEditor.setIgnoreWhitespaceInDiff(!strict)
      this.#logger.debug(`Strict diff ${strict ? 'enabled' : 'disabled'}`)
    })

    toolbar.prevDiffBtn.addEventListener('widget-click', () => this.#xmlEditor.goToPreviousDiff())
    toolbar.nextDiffBtn.addEventListener('widget-click', () => this.#xmlEditor.goToNextDiff())
    toolbar.rejectAllBtn.addEventListener('widget-click', () => {
      this.#xmlEditor.rejectAllDiffs()
      this.hide()
    })
    toolbar.acceptAllBtn.addEventListener('widget-click', () => {
      this.#xmlEditor.acceptAllDiffs()
      this.hide()
    })

    xmlEditor.on(XMLEditor.EVENT_EDITOR_SHOW_MERGE_VIEW, () => {
      this.#mergeViewActive = true
      this.#updateButtons()
    })
    xmlEditor.on(XMLEditor.EVENT_EDITOR_HIDE_MERGE_VIEW, () => {
      this.#mergeViewActive = false
      this.#updateButtons()
    })
    this.#updateButtons()

    // Esc ends the merge view, unless focus mode is on (the xpath-navigation plugin leaves it then)
    document.addEventListener('keydown', (evt) => this.#onEscapeKey(evt))
  }

  /**
   * @param {string[]} changedKeys
   */
  async onStateUpdate(changedKeys) {
    const state = this.state
    // When diff is cleared externally (e.g. logout), hide the merge view
    if (!state?.diff && this.#xmlEditor.isMergeViewActive()) {
      await this.#xmlEditor.hideMergeView()
    }
    this.#updateButtons()
    if (changedKeys.some(key => VERSION_LIST_KEYS.includes(key))) {
      this.#populateSelect()
    } else {
      this.#select.value = state?.diff || ""
    }
  }

  //
  // Public API
  //

  /**
   * Shows the merge view, which compares the open document with the given version, and switches
   * validation off, as it creates too much visual noise there.
   * @param {string} diff - The stable id of the version to compare with
   * @returns {Promise<void>}
   * @throws {TypeError} If `diff` is not a stable id
   */
  async show(diff) {
    if (!diff || typeof diff != "string") {
      throw new TypeError("Invalid diff value")
    }
    this.#logger.info("Loading diff XML: " + diff)
    ui.spinner.show('Computing file differences, please wait...')
    try {
      await this.#xmlEditor.showMergeView(`/api/files/${diff}`)
      if (!this.state || this.state.diff !== diff) {
        await this.dispatchStateChange({ diff })
      }
      await this.context.invokePluginEndpoint(ep.validation.configure, [{ mode: "off" }], { throws: false })
    } finally {
      ui.spinner.hide()
    }
  }

  /**
   * Hides the merge view, keeping the open document, switches validation on again and removes the
   * `diff` from the state and the URL.
   * @returns {Promise<void>}
   */
  async hide() {
    await this.#xmlEditor.hideMergeView()
    await this.context.invokePluginEndpoint(ep.validation.configure, [{ mode: "auto" }], { throws: false })
    if (this.state && this.state.diff) {
      UrlHash.remove("diff")
      await this.dispatchStateChange({ diff: null })
    }
  }

  /**
   * Returns the "Compare with version" selectbox as a main toolbar contribution.
   * @returns {PanelContribution[]}
   */
  getToolbarContentItems() {
    return [{ element: this.#select, order: 10, priority: 9, position: 'center' }]
  }

  /**
   * Disables the selectbox while the file data is loaded and repopulates it afterwards.
   * @param {boolean} isLoading
   */
  loading(isLoading) {
    this.#isFileLoading = isLoading
    this.#setSelectLoadingState(isLoading)
    if (!isLoading && this.state?.fileData) {
      this.#populateSelect()
    }
  }

  //
  // Private methods
  //

  /** Opens and changes the merge view from the selectbox, ignoring programmatic value changes */
  #installSelectHandlers() {
    const select = this.#select
    select.addEventListener('sl-show', () => {
      this.#userOpenedSelect = true
      select.closest('tool-bar')?.classList.add('dropdown-open')
      // Without a diff, sl-select highlights the first option on open, which looks like a
      // selection. Clear the highlight after sl-select has set it (in the next animation frame).
      if (select.value) return
      requestAnimationFrame(() => requestAnimationFrame(() => {
        select.querySelectorAll('sl-option').forEach(option => { /** @type {SlOption} */ (option).current = false })
      }))
    })
    select.addEventListener('sl-change', async () => {
      if (!this.#userOpenedSelect) return
      this.#userOpenedSelect = false
      await this.#onChangeSelection(/** @type {string} */ (select.value))
    })
    select.addEventListener('sl-hide', () => {
      setTimeout(() => {
        this.#userOpenedSelect = false
        // other selectboxes of the toolbar may still be open
        const toolbar = select.closest('tool-bar')
        if (toolbar && !toolbar.querySelector('sl-select[open]')) toolbar.classList.remove('dropdown-open')
      }, 0)
    })
  }

  /** @param {string} diff */
  async #onChangeSelection(diff) {
    if (diff && diff !== this.state.xml) {
      try {
        await this.show(diff)
      } catch (error) {
        this.#logger.error(String(error))
      }
    } else {
      await this.hide()
    }
    await this.scheduleStateChange({ diff })
  }

  /** Lists the versions of the selected document, the same as the "Target XML" selectbox */
  #populateSelect() {
    const state = this.state
    if (this.#isFileLoading || !state?.fileData) return
    this.#select.innerHTML = ""
    if (state.fileData.length > 0) {
      appendVersionOptions(this.#select, getSelectedFileVersions(filterFileData(state), state), state.variant)
    }
    this.#select.value = state.diff || ""
  }

  /** @param {boolean} isLoading */
  #setSelectLoadingState(isLoading) {
    this.#select.disabled = isLoading
    this.#select.classList.toggle('loading', isLoading)
  }

  /**
   * Enables and highlights the diff buttons while the merge view is shown in an editable document.
   * The strict-diff toggle is a display preference, not an edit action, so it stays enabled in a
   * read-only document and only depends on the merge view being shown.
   */
  #updateButtons() {
    const toolbar = ui.xmlEditor.toolbar
    const enabled = this.#mergeViewActive && !this.state?.editorReadOnly
    for (const name of DIFF_BUTTON_NAMES) {
      const button = toolbar[name]
      button.disabled = !enabled
      button.classList.toggle('merge-view-highlight', enabled)
    }
    toolbar.strictDiffToggle.disabled = !this.#mergeViewActive
  }

  /**
   * Reads the strict-diff preference. It was stored by the xmleditor plugin before the merge view
   * controls became a plugin of their own; a value stored there is moved over once.
   * @returns {boolean}
   */
  #getStrictDiffPreference() {
    const legacy = this.context.getUIStorage('xmleditor')
    const legacyValue = legacy.get('strictDiff')
    if (legacyValue !== undefined) {
      if (this.uiStorage.get('strictDiff') === undefined) this.uiStorage.set('strictDiff', legacyValue)
      legacy.remove('strictDiff')
    }
    return this.uiStorage.get('strictDiff', false)
  }

  /** @param {boolean} enabled */
  #setStrictDiffPreference(enabled) {
    this.uiStorage.set('strictDiff', enabled)
  }

  /**
   * Handles the Escape key: ends the merge view, unless focus mode is on (the xpath-navigation
   * plugin leaves focus mode then). Ignored if the key was already handled (e.g. by CodeMirror closing
   * the search panel or the autocomplete popup) or pressed inside a dialog, drawer or dropdown.
   * @param {KeyboardEvent} evt
   */
  async #onEscapeKey(evt) {
    if (evt.key !== 'Escape' || evt.defaultPrevented) return
    const inOverlay = evt.composedPath().some(el =>
      el instanceof HTMLElement && ['SL-DIALOG', 'SL-DRAWER', 'SL-DROPDOWN'].includes(el.tagName))
    if (inOverlay || this.#xmlEditor.isFocusMode()) return
    if (this.#mergeViewActive) {
      await this.hide()
    }
  }
}

export default MergeViewPlugin
