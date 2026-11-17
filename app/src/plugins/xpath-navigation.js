/**
 * XPath navigation plugin: the node navigation in the center of the XML editor statusbar. An XPath
 * expression chosen in the dropdown selects the matching nodes, which the user steps through with the
 * ‹ › buttons, optionally in focus mode. The current node is kept in the `xpath` state.
 *
 * The expressions of a variant are the defaults of the extractors, which cannot be changed, plus the
 * expressions that annotators, reviewers and admins add in the "Navigation XPaths" dialog, opened with
 * the "Edit..." entry of the dropdown. They are stored on the server (`/api/v1/navigation-xpath`).
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { StatusText } from '../modules/panels/widgets/status-text.js'
 * @import { StatusButton } from '../modules/panels/widgets/status-button.js'
 * @import { StatusToggleButton } from '../modules/panels/widgets/status-toggle-button.js'
 * @import { StatusDropdown, StatusDropdownItem } from '../modules/panels/widgets/status-dropdown.js'
 * @import { SlDialog } from '../ui.js'
 * @import { UserData } from './authentication.js'
 * @import { NavigationXpathItem } from '../modules/api-client-v1.js'
 * @import { xpathNavigationDialogPart } from '../templates/xpath-navigation-dialog.types.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ep from '../extension-points.js'
import { updateUi } from '../ui.js'
import { PanelUtils } from '../modules/panels/index.js'
import { parseXPath } from '../modules/utils.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'
import { userHasRole } from '../modules/acl-utils.js'
import { notify } from '../modules/sl-utils.js'
import { checkNavigationXpath, labelToText } from '../modules/navigation-xpath-utils.js'

await registerTemplate('xpath-navigation-dialog', 'xpath-navigation-dialog.html')

/**
 * The widgets of the node navigation, added to the XML editor statusbar
 * @typedef {object} xpathNavigationStatusbarPart
 * @property {StatusButton} prevNodeBtn - Previous node navigation button
 * @property {StatusDropdown} xpathDropdown - XPath selector dropdown, with an "Edit..." entry for users who can edit the list
 * @property {StatusButton} nextNodeBtn - Next node navigation button
 * @property {StatusText} nodeCounterWidget - Node counter display (index/size)
 * @property {StatusToggleButton} focusToggle - Toggles focus mode (center navigated-to node, dim the rest)
 * @property {StatusButton} clearNodeBtn - Clears the current node (removes focus on it and the `xpath` state)
 */

/** Priority of the navigation widgets: they outrank the review meter (4) and give way only to the comment meter (6) */
const NAVIGATION_PRIORITY = 5

/** Name of the dropdown command that opens the dialog */
const EDIT_ACTION = 'edit'

/** Roles that can add, change and delete navigation XPaths */
const EDITOR_ROLES = ['annotator', 'reviewer', 'admin']

/** UI storage namespace of the XML editor plugin, which stored the preferences of the navigation before */
const LEGACY_STORAGE_NAMESPACE = 'xmleditor'

class XpathNavigationPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, {
      name: 'xpath-navigation',
      deps: ['logger', 'client', 'xmleditor']
    })
  }

  static extensionPoints = [ep.xmlEditor.contextMenuItems];

  /**
   * Extension point handler for `ep.xmlEditor.contextMenuItems`.
   * Called by the XML editor plugin during start() to collect the context menu items; contributes the
   * "Insert </tag><tag>" item for the tag of the selected navigation XPath.
   * Delegates to {@link XpathNavigationPlugin#getContextMenuItems}.
   * @returns {Array<{element: HTMLElement, onBeforeShow: (ctx: {readOnly: boolean}) => void}>}
   */
  [ep.xmlEditor.contextMenuItems]() { return this.getContextMenuItems() }

  get #logger() { return this.getDependency('logger') }
  get #client() { return this.getDependency('client') }
  get #xmlEditor() { return this.getDependency('xmleditor') }

  /** @type {StatusButton} */
  #prevNodeBtn
  /** @type {StatusDropdown} */
  #xpathDropdown
  /** @type {StatusButton} */
  #nextNodeBtn
  /** @type {StatusText} */
  #nodeCounterWidget
  /** @type {StatusButton} */
  #clearNodeBtn
  /** @type {StatusToggleButton} */
  #focusToggle

  /** @type {SlDialog & xpathNavigationDialogPart} */
  #dialogUi

  /** Whether the user has focus mode switched on (persisted in the UI storage) */
  #focusPreferred = true
  /** Whether the navigation widgets are currently shown */
  #navigationVisible = false
  /** Whether node navigation is on, i.e. an xpath is selected. Focus mode only works then */
  #navigationActive = false

  /** @type {string|null} */
  #currentVariant = null
  /** @type {UserData|null} */
  #currentUser = null
  /**
   * The entries of all variants, loaded from the server; null until loaded
   * @type {Record<string, NavigationXpathItem[]>|null}
   */
  #entriesByVariant = null
  /**
   * The variants that an extractor supports, i.e. that can have navigation XPaths
   * @type {Set<string>}
   */
  #knownVariants = new Set()
  /** @type {Promise<void>|null} */
  #loading = null
  /** The value of the entry being edited in the dialog, or null when adding */
  #editingValue = /** @type {string|null} */ (null)

  /** @param {ApplicationState} initialState */
  async install(initialState) {
    await super.install(initialState)
    this.#migrateLegacyPreferences()

    this.#prevNodeBtn = PanelUtils.createButton({ icon: 'chevron-left', tooltip: 'Previous node', name: 'prevNodeBtn' })
    this.#xpathDropdown = PanelUtils.createDropdown({ placeholder: 'Select XPath...', name: 'xpathDropdown' })
    this.#nextNodeBtn = PanelUtils.createButton({ icon: 'chevron-right', tooltip: 'Next node', name: 'nextNodeBtn' })
    this.#nodeCounterWidget = PanelUtils.createText({ text: '(0/0)', name: 'nodeCounterWidget' })
    this.#focusToggle = PanelUtils.createToggleButton({
      icon: 'search',
      tooltip: 'Focus on the navigated-to node (Esc to exit)',
      appearance: 'flat',
      name: 'focusToggle',
      disabled: true
    })
    this.#clearNodeBtn = PanelUtils.createButton({
      icon: 'x-lg',
      tooltip: 'Turn off node navigation',
      name: 'clearNodeBtn',
      disabled: true
    })
    for (const widget of [this.#prevNodeBtn, this.#xpathDropdown, this.#nextNodeBtn, this.#nodeCounterWidget,
      this.#focusToggle, this.#clearNodeBtn]) {
      this.#xmlEditor.addStatusbarWidget(widget, 'center', NAVIGATION_PRIORITY)
    }
    this.#focusPreferred = this.uiStorage.get('focusMode', true)
    this.#focusToggle.checked = this.#focusPreferred
    updateUi()
    this.#setWidgetsVisible(false, false)

    this.#xpathDropdown.addEventListener('widget-change', async (evt) => {
      const baseXpath = /** @type {CustomEvent} */ (evt).detail.value
      if (this.#currentVariant) {
        this.#setXpathPreference(this.#currentVariant, baseXpath)
      }
      await this.dispatchStateChange({ xpath: baseXpath ? `${baseXpath}[1]` : '' })
    })
    this.#xpathDropdown.addEventListener('widget-action', (evt) => {
      if (/** @type {CustomEvent} */ (evt).detail.action === EDIT_ACTION) this.showDialog()
    })
    this.#prevNodeBtn.addEventListener('widget-click', () => this.#changeNodeIndex(this.state, -1))
    this.#nextNodeBtn.addEventListener('widget-click', () => this.#changeNodeIndex(this.state, +1))
    this.#nodeCounterWidget.addEventListener('click', () => this.#onClickSelectionIndex())

    // Clear button: turns node navigation off. Removes the focus on the current node and the xpath
    // state (and thus the URL parameter) and forgets the stored xpath selection of the variant, so that
    // navigation only resumes when a new xpath is selected in the dropdown.
    this.#clearNodeBtn.addEventListener('widget-click', async () => {
      if (this.#currentVariant) {
        this.#setXpathPreference(this.#currentVariant, '')
      }
      this.#xmlEditor.clearSelectedNode()
      await this.dispatchStateChange({ xpath: null })
    })
    this.#focusToggle.addEventListener('widget-change', (e) => {
      this.#setFocusMode(/** @type {CustomEvent} */ (e).detail.checked)
    })
    // Esc leaves focus mode (the XML editor plugin leaves the visual diff mode only when focus mode is off)
    document.addEventListener('keydown', (evt) => this.#onEscapeKey(evt))

    // selection => xpath state. setTimeout keeps the state change out of an active state-update propagation
    // cycle (e.g. when selectByXpath triggers CodeMirror's synchronous update).
    this.#xmlEditor.on('selectionChanged', () => {
      setTimeout(() => {
        if (this.state) this.#onSelectionChange(this.state)
      }, 0)
    })

    // Select the stored xpath of the variant after a document is loaded, unless the state has one
    this.#xmlEditor.on('editorAfterLoad', () => {
      this.#xmlEditor.whenReady().then(() => setTimeout(async () => {
        if (this.state?.xpath || !this.state?.variant) return
        const savedXpath = this.#getXpathPreference(this.state.variant)
        if (savedXpath && this.#selectableValues().includes(savedXpath)) {
          await this.scheduleStateChange({ xpath: `${savedXpath}[1]` })
        }
      }, 0))
    })

    this.#installDialog()
  }

  /**
   * Runs when application startup is complete. Late layout changes during startup (e.g. line
   * wrapping, folding the header, switching to the visual mode) shift the node that was selected
   * from the restored xpath, so center it once more after they have settled.
   */
  async ready() {
    await new Promise(resolve => setTimeout(resolve, 300))
    if (this.state?.xpath && this.#xmlEditor.isReady()) {
      this.#xmlEditor.scrollSelectionToCenter()
    }
  }

  /**
   * @param {string[]} _changedKeys
   * @param {ApplicationState} state
   */
  async onStateUpdate(_changedKeys, state) {
    // Reload the entries lazily when the user changes
    if (this.#currentUser !== state.user) {
      this.#currentUser = state.user
      this.#entriesByVariant = null
      this.#currentVariant = null
    }

    if (this.#currentVariant !== state.variant) {
      this.#currentVariant = state.variant
      await this.#populateDropdown(state)
    }

    const hasEntries = this.#selectableValues().length > 0
    const canEdit = this.#canEdit(state)
    this.#setWidgetsVisible(Boolean(state.xml) && (hasEntries || canEdit), Boolean(state.xml) && hasEntries)

    // xpath state => dropdown selection and counter
    if (state.xpath && !state.xpath.startsWith('/')) {
      this.#logger.warn(`Discarding invalid xpath state: "${state.xpath}"`)
      this.scheduleStateChange({ xpath: '' })
    }
    if (state.xpath?.startsWith('/')) {
      const { index, pathBeforePredicates, nonIndexPredicates } = parseXPath(state.xpath)
      const nonIndexedPath = pathBeforePredicates + nonIndexPredicates
      this.#xpathDropdown.selected = this.#selectableValues().includes(nonIndexedPath) ? nonIndexedPath : ''
      this.#xmlEditor.whenReady().then(() => this.#updateNodeCounter(nonIndexedPath, index))
    } else if (!state.xpath) {
      // no node selected: navigation is off until an xpath is selected in the dropdown
      this.#xpathDropdown.selected = ''
      this.#nodeCounterWidget.text = '(0/0)'
      this.#prevNodeBtn.disabled = this.#nextNodeBtn.disabled = true
    }

    this.#updateNavigationActive(state)

    // xpath state => editor selection
    if (this.#xmlEditor.isReady() && state.xpath?.startsWith('/') && state.xml) {
      const { index, pathBeforePredicates } = parseXPath(state.xpath)
      try {
        const size = this.#xmlEditor.countDomNodesByXpath(pathBeforePredicates)
        const pathChanged = this.#xmlEditor.parentPath !== pathBeforePredicates
        const indexChanged = index !== this.#xmlEditor.currentIndex
        if (size > 0 && (pathChanged || indexChanged)) {
          this.#xmlEditor.parentPath = pathBeforePredicates
          this.#xmlEditor.selectByIndex(index || 1)
        }
      } catch (e) {
        this.#logger.error(e)
      }
    }
  }

  /**
   * The context menu item that inserts a tag boundary for the tag of the selected navigation XPath.
   * @returns {Array<{element: HTMLElement, onBeforeShow: (ctx: {readOnly: boolean}) => void}>}
   */
  getContextMenuItems() {
    const item = document.createElement('sl-menu-item')
    item.addEventListener('click', () => {
      const tagName = tagNameFromXpath(this.#xpathDropdown.selected)
      if (!tagName) return
      const view = this.#xmlEditor.getView()
      const { head } = view.state.selection.main
      view.dispatch({ changes: { from: head, to: head, insert: `</${tagName}><${tagName}>` }, userEvent: 'input' })
    })
    return [{
      element: item,
      onBeforeShow: ({ readOnly }) => {
        const tagName = tagNameFromXpath(this.#xpathDropdown.selected)
        item.disabled = readOnly || !tagName
        item.textContent = tagName ? `Insert </${tagName}><${tagName}>` : 'Insert tag boundary'
      }
    }]
  }

  /**
   * The navigation entries of a variant, defaults first. Empty until the entries are loaded.
   * @param {string} variant
   * @returns {NavigationXpathItem[]}
   */
  getEntries(variant) {
    return this.#entriesByVariant?.[variant] ?? []
  }

  /** Opens the "Navigation XPaths" dialog for the current variant */
  async showDialog() {
    const variant = this.state?.variant
    if (!variant || !this.#canEdit(this.state)) return
    const ui = this.#dialogUi
    ui.intro.textContent = `XPath expressions of the variant "${variant}" in the navigation dropdown. The expressions provided by the extractor cannot be changed or deleted.`
    this.#resetForm()
    this.#renderEntries()
    await ui.show()
    ui.entryForm.xpathInput.focus()
  }

  //
  // Dropdown
  //

  /** @returns {Promise<void>} */
  async #load() {
    if (this.#entriesByVariant) return
    if (!this.#loading) {
      this.#loading = (async () => {
        try {
          const [{ variants }, extractors] = await Promise.all([
            this.#client.apiClient.navigationXpathList(),
            this.#client.getExtractorList()
          ])
          this.#entriesByVariant = variants
          this.#knownVariants = new Set(extractors.flatMap(extractor => extractor.variants ?? []))
          this.#logger.debug('Loaded navigation XPaths')
        } finally {
          this.#loading = null
        }
      })()
    }
    await this.#loading
  }

  /** @param {ApplicationState} state */
  async #populateDropdown(state) {
    const variant = state.variant
    if (!variant) {
      this.#setItems([{ value: '', text: 'No variant selected', disabled: true }], state)
      return
    }
    if (!state.user) {
      this.#xpathDropdown.setItems([])
      return
    }
    try {
      await this.#load()
    } catch (error) {
      this.#logger.warn('Failed to load navigation XPaths: ' + String(error))
      this.#xpathDropdown.setItems([{ value: '', text: 'Error loading navigation paths', disabled: true }])
      return
    }
    // the variant may have changed while loading
    if (variant !== this.state?.variant) return
    const items = this.getEntries(variant).map(entry => ({ value: entry.value, text: entry.label }))
    this.#setItems(items.length ? items : [{ value: '', text: `No navigation paths for variant: ${variant}`, disabled: true }], state)
  }

  /**
   * Sets the dropdown items, with the "Edit..." entry if the user can edit the list
   * @param {StatusDropdownItem[]} items
   * @param {ApplicationState} state
   */
  #setItems(items, state) {
    if (this.#canEdit(state)) {
      items = [...items, { divider: true }, { action: EDIT_ACTION, text: 'Edit...', icon: 'pencil-square' }]
    }
    this.#xpathDropdown.setItems(items)
  }

  /** @returns {string[]} The values of the selectable dropdown entries */
  #selectableValues() {
    return (this.#xpathDropdown.items || [])
      .filter(item => !item.action && !item.divider && !item.disabled && item.value)
      .map(item => item.value)
  }

  /**
   * Whether the user can edit the navigation XPaths of the current variant
   * @param {ApplicationState|null} state
   * @returns {boolean}
   */
  #canEdit(state) {
    return Boolean(state?.variant && state.user && userHasRole(state.user, EDITOR_ROLES)
      && this.#knownVariants.has(state.variant))
  }

  /**
   * Shows or hides the navigation widgets
   * @param {boolean} dropdownVisible - whether the dropdown is shown
   * @param {boolean} controlsVisible - whether the other navigation widgets are shown
   */
  #setWidgetsVisible(dropdownVisible, controlsVisible) {
    this.#xpathDropdown.style.display = dropdownVisible ? 'inline-flex' : 'none'
    for (const widget of [this.#prevNodeBtn, this.#nextNodeBtn, this.#nodeCounterWidget, this.#clearNodeBtn, this.#focusToggle]) {
      widget.style.display = controlsVisible ? 'inline-flex' : 'none'
    }
    this.#navigationVisible = controlsVisible
  }

  //
  // Navigation
  //

  /**
   * Called when the selection in the editor changes to update the xpath state. Only dispatches when a
   * normative parentPath is active (i.e. the user has selected a navigation path in the dropdown), so
   * that random clicks without a selected xpath type do not overwrite state.
   * @param {ApplicationState} state
   */
  async #onSelectionChange(state) {
    if (!this.#xmlEditor.parentPath) return
    const selectedXpath = this.#xmlEditor.selectedXpath
    if (!selectedXpath) {
      this.#logger.debug('Could not determine xpath of last selected node')
      return
    }
    if (selectedXpath !== state.xpath) {
      await this.dispatchStateChange({ xpath: selectedXpath })
    }
  }

  /**
   * @param {string} xpath
   * @param {number|null} index
   */
  #updateNodeCounter(xpath, index) {
    let size
    try {
      size = this.#xmlEditor.countDomNodesByXpath(xpath)
    } catch (e) {
      this.#logger.warn('Cannot update counter: ' + String(e))
      size = 0
    }
    index = index || 1
    this.#nodeCounterWidget.text = `(${size > 0 ? index : 0}/${size})`
    this.#nextNodeBtn.disabled = this.#prevNodeBtn.disabled = size < 2
  }

  /**
   * Navigate to previous/next node
   * @param {ApplicationState|null} state
   * @param {number} delta
   */
  async #changeNodeIndex(state, delta) {
    if (!state?.xpath) return
    let { pathBeforePredicates, nonIndexPredicates, index } = parseXPath(state.xpath)
    const normativeXpath = pathBeforePredicates + nonIndexPredicates
    const size = this.#xmlEditor.countDomNodesByXpath(normativeXpath)
    if (size < 2) return
    if (index === null) index = 1
    index += delta
    if (index < 1) index = size
    if (index > size) index = 1
    await this.dispatchStateChange({ xpath: normativeXpath + `[${index}]` })
  }

  /** Called when the user clicks on the counter to enter the node index */
  async #onClickSelectionIndex() {
    const index = prompt('Enter node index')
    if (!index) return
    const parsedIndex = parseInt(index, 10)
    if (isNaN(parsedIndex) || !this.state?.xpath) return
    try {
      const { pathBeforePredicates, nonIndexPredicates } = parseXPath(this.state.xpath)
      await this.dispatchStateChange({ xpath: `${pathBeforePredicates}${nonIndexPredicates}[${parsedIndex}]` })
    } catch (error) {
      this.#logger.warn('Failed to select by index: ' + String(error))
    }
  }

  //
  // Focus mode
  //

  /**
   * Switches node navigation on or off: it is on while an xpath is selected. The buttons that only
   * make sense with an active navigation are disabled otherwise. Focus mode is switched off while the
   * navigation is off, but its stored choice is kept and applies again when navigation resumes.
   * @param {ApplicationState} state
   */
  #updateNavigationActive(state) {
    const active = this.#navigationVisible && Boolean(state.xpath)
    this.#focusToggle.disabled = !active
    this.#clearNodeBtn.disabled = !active
    if (active !== this.#navigationActive) {
      this.#navigationActive = active
      this.#applyFocusMode()
    }
  }

  /**
   * Turns focus mode on or off as a user choice: keeps the statusbar toggle in sync and persists the
   * choice. Enabling it also turns on line wrapping, without changing the stored wrapping preference.
   * @param {boolean} enabled
   */
  #setFocusMode(enabled) {
    this.#focusPreferred = enabled
    this.uiStorage.set('focusMode', enabled)
    this.#focusToggle.checked = enabled
    if (enabled) {
      this.#xmlEditor.wrapLinesTransiently()
    }
    this.#applyFocusMode()
    this.#logger.debug(`Focus mode ${enabled ? 'enabled' : 'disabled'}`)
  }

  /** Applies the stored focus mode choice to the editor: it only takes effect while node navigation is on */
  #applyFocusMode() {
    this.#xmlEditor.setFocusMode(this.#focusPreferred && this.#navigationActive)
  }

  /**
   * Leaves focus mode on Escape. Ignored if the key was already handled (e.g. by CodeMirror closing the
   * search panel or the autocomplete popup) or pressed inside a dialog, drawer or dropdown.
   * @param {KeyboardEvent} evt
   */
  #onEscapeKey(evt) {
    if (evt.key !== 'Escape' || evt.defaultPrevented) return
    const inOverlay = evt.composedPath().some(el =>
      el instanceof HTMLElement && ['SL-DIALOG', 'SL-DRAWER', 'SL-DROPDOWN'].includes(el.tagName))
    if (inOverlay) return
    if (this.#xmlEditor.isFocusMode()) {
      this.#setFocusMode(false)
    }
  }

  //
  // Preferences
  //

  /**
   * Takes over the preferences that the XML editor plugin stored before the navigation was moved here
   */
  #migrateLegacyPreferences() {
    const legacy = this.context.getUIStorage(LEGACY_STORAGE_NAMESPACE)
    const focusMode = legacy.get('focusMode', null)
    if (focusMode !== null) {
      if (this.uiStorage.get('focusMode', null) === null) this.uiStorage.set('focusMode', focusMode)
      legacy.remove('focusMode')
    }
  }

  /**
   * @param {string} variantId
   * @returns {string|null}
   */
  #getXpathPreference(variantId) {
    const xpath = this.uiStorage.get(`xpath.${variantId}`, null)
    if (xpath !== null) return xpath
    const legacy = this.context.getUIStorage(LEGACY_STORAGE_NAMESPACE)
    const legacyXpath = legacy.get(`xpath.${variantId}`, null)
    if (legacyXpath !== null) {
      legacy.remove(`xpath.${variantId}`)
      this.#setXpathPreference(variantId, legacyXpath)
    }
    return legacyXpath
  }

  /**
   * @param {string} variantId
   * @param {string} xpath
   */
  #setXpathPreference(variantId, xpath) {
    if (xpath) {
      this.uiStorage.set(`xpath.${variantId}`, xpath)
    } else {
      this.uiStorage.remove(`xpath.${variantId}`)
    }
  }

  //
  // Dialog
  //

  #installDialog() {
    this.#dialogUi = /** @type {SlDialog & xpathNavigationDialogPart} */ (/** @type {unknown} */ (
      this.createUi(createSingleFromTemplate('xpath-navigation-dialog', document.body))))
    const ui = this.#dialogUi
    ui.closeBtn.addEventListener('click', () => ui.hide())
    ui.entryForm.addEventListener('submit', (event) => {
      event.preventDefault()
      this.#submitForm()
    })
    ui.entryForm.cancelEditBtn.addEventListener('click', () => this.#resetForm())
    ui.entryForm.xpathInput.addEventListener('sl-input', () => this.#showXpathError(null))
  }

  /** Renders the entries of the current variant as a table */
  #renderEntries() {
    const ui = this.#dialogUi
    const variant = this.state?.variant ?? ''
    const entries = this.getEntries(variant)
    ui.entryList.replaceChildren()
    if (entries.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'xpath-navigation-empty'
      empty.textContent = 'There are no navigation XPaths for this variant.'
      ui.entryList.append(empty)
      return
    }
    const table = document.createElement('table')
    table.className = 'xpath-navigation-table'
    const head = table.createTHead().insertRow()
    for (const title of ['XPath', 'Label', '']) {
      const th = document.createElement('th')
      th.textContent = title
      head.append(th)
    }
    const body = table.createTBody()
    for (const entry of entries) {
      const editable = entry.edit !== false
      const row = body.insertRow()
      row.dataset.value = entry.value
      row.classList.toggle('default', !editable)
      row.classList.toggle('editing', entry.value === this.#editingValue)
      const xpathCell = row.insertCell()
      xpathCell.className = 'xpath-navigation-xpath'
      xpathCell.textContent = entry.value
      row.insertCell().textContent = labelToText(entry.label)
      const actions = row.insertCell()
      actions.className = 'xpath-navigation-actions'
      if (editable) {
        actions.append(
          this.#iconButton('pencil', 'Edit', 'edit-btn', () => this.#startEdit(entry)),
          this.#iconButton('trash', 'Delete', 'delete-btn', () => this.#deleteEntry(entry))
        )
      } else {
        const badge = document.createElement('span')
        badge.className = 'xpath-navigation-default'
        badge.title = 'Provided by the extractor, cannot be changed'
        const icon = document.createElement('sl-icon')
        icon.setAttribute('name', 'lock')
        badge.append(icon, 'Default')
        actions.append(badge)
      }
    }
    ui.entryList.append(table)
  }

  /**
   * @param {string} icon
   * @param {string} label
   * @param {string} testId
   * @param {() => void} onClick
   * @returns {HTMLElement}
   */
  #iconButton(icon, label, testId, onClick) {
    const button = document.createElement('sl-icon-button')
    button.setAttribute('name', icon)
    button.setAttribute('label', label)
    button.title = label
    button.dataset.testid = testId
    button.addEventListener('click', onClick)
    return button
  }

  /** @param {NavigationXpathItem} entry */
  #startEdit(entry) {
    const form = this.#dialogUi.entryForm
    this.#editingValue = entry.value
    form.formTitle.textContent = 'Edit XPath'
    form.xpathInput.value = entry.value
    const label = labelToText(entry.label)
    form.labelInput.value = label === entry.value ? '' : label
    form.submitBtn.textContent = 'Save'
    form.cancelEditBtn.style.display = ''
    this.#showXpathError(null)
    this.#renderEntries()
    form.xpathInput.focus()
  }

  #resetForm() {
    const form = this.#dialogUi.entryForm
    this.#editingValue = null
    form.formTitle.textContent = 'Add XPath'
    form.xpathInput.value = ''
    form.labelInput.value = ''
    form.submitBtn.textContent = 'Add'
    form.cancelEditBtn.style.display = 'none'
    this.#showXpathError(null)
  }

  /** @param {string|null} message */
  #showXpathError(message) {
    const el = this.#dialogUi.entryForm.xpathError
    el.textContent = message ?? ''
    el.style.display = message ? '' : 'none'
  }

  /** Adds the entry of the form, or saves the entry being edited */
  async #submitForm() {
    const form = this.#dialogUi.entryForm
    const variant = this.state?.variant
    if (!variant) return
    const xpath = form.xpathInput.value.trim()
    const label = form.labelInput.value.trim()
    const error = checkNavigationXpath(xpath)
    if (error) {
      this.#showXpathError(error)
      return
    }
    const entries = this.getEntries(variant)
    const duplicate = entries.find(entry => entry.value === xpath && entry.value !== this.#editingValue)
    if (duplicate) {
      this.#showXpathError(duplicate.edit === false
        ? 'This XPath expression is provided by the extractor'
        : 'This XPath expression is already in the list')
      return
    }
    const custom = this.#customInputs(entries)
    const editIndex = custom.findIndex(entry => entry.value === this.#editingValue)
    if (editIndex >= 0) {
      custom[editIndex] = { value: xpath, label }
    } else {
      custom.push({ value: xpath, label })
    }
    const previous = this.#editingValue
    const previousSelected = Boolean(previous) && this.#xpathDropdown.selected === previous
    if (await this.#save(variant, custom)) {
      this.#resetForm()
      // keep the navigation on an edited expression that is currently selected
      if (previousSelected && previous !== xpath) {
        this.#setXpathPreference(variant, xpath)
        await this.dispatchStateChange({ xpath: `${xpath}[1]` })
      }
    }
  }

  /** @param {NavigationXpathItem} entry */
  async #deleteEntry(entry) {
    const variant = this.state?.variant
    if (!variant) return
    const custom = this.#customInputs(this.getEntries(variant)).filter(e => e.value !== entry.value)
    const wasSelected = this.#xpathDropdown.selected === entry.value
    if (!await this.#save(variant, custom)) return
    if (this.#editingValue === entry.value) {
      this.#resetForm()
    }
    // turn the navigation off if it was on the deleted expression
    if (wasSelected) {
      this.#setXpathPreference(variant, '')
      this.#xmlEditor.clearSelectedNode()
      await this.dispatchStateChange({ xpath: null })
    }
  }

  /**
   * The user entries as input for the server, with plain-text labels (empty if the label is the expression)
   * @param {NavigationXpathItem[]} entries
   * @returns {Array<{value: string, label: string}>}
   */
  #customInputs(entries) {
    return entries.filter(entry => entry.edit !== false).map(entry => {
      const label = labelToText(entry.label)
      return { value: entry.value, label: label === entry.value ? '' : label }
    })
  }

  /**
   * Saves the user entries of a variant and updates the dialog and the dropdown
   * @param {string} variant
   * @param {Array<{value: string, label: string}>} custom
   * @returns {Promise<boolean>} Whether the entries were saved
   */
  async #save(variant, custom) {
    try {
      const { entries } = await this.#client.apiClient.navigationXpathSave(variant, { entries: custom })
      this.#entriesByVariant = { ...(this.#entriesByVariant ?? {}), [variant]: entries }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#showXpathError(message)
      notify(`Cannot save the navigation XPaths: ${message}`, 'danger', 'exclamation-octagon')
      return false
    }
    this.#renderEntries()
    if (this.state) {
      await this.#populateDropdown(this.state)
      // re-apply the selection, visibility and counter to the new items
      await this.onStateUpdate([], this.state)
    }
    return true
  }
}

/**
 * Extracts the local element name from an XPath expression (last step, no predicates).
 * E.g. `//body/listBibl/bibl[@type="cited"]` → `bibl`
 * @param {string} xpath
 * @returns {string|null}
 */
export function tagNameFromXpath(xpath) {
  if (!xpath) return null
  const steps = xpath.split('/').filter(Boolean)
  const lastStep = steps[steps.length - 1]
  return lastStep?.replace(/\[.*$/, '').replace(/^[^:]+:/, '') || null
}

export default XpathNavigationPlugin

/** @deprecated Use XpathNavigationPlugin class directly */
export const plugin = XpathNavigationPlugin
