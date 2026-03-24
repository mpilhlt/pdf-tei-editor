/**
 * Toolbar Plugin
 *
 * Creates and manages the main toolbar layout. The toolbar menu is inserted at
 * the beginning during install() so dependent plugins can add menu items, then
 * moved to the end in start() after all plugins have run. Also wires up a
 * toolbar-wide z-index fix for sl-dropdown / sl-select elements.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * @import { SlSelect, SlButton, SlButtonGroup, SlDropdown, UIPart } from '../ui.js'
 * @import { documentActionsPart } from './document-actions.js'
 * @import { extractionActionsPart } from './extraction.js'
 * @import { fileDrawerTriggerPart } from './file-selection-drawer.js'
 * @import { toolsGroupPart } from './tools.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import ui, { updateUi } from '../ui.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'

// Register template
await registerTemplate('toolbar-menu-button', 'toolbar-menu-button.html')

//
// UI Parts
//

/**
 * Toolbar menu dropdown structure
 * @typedef {object} toolbarMenuPart
 * @property {SlButton} menuBtn - The menu trigger button
 * @property {object} menu - The menu container
 * @property {import('../ui.js').SlMenuItem} [menu.infoMenuItem] - Info/manual menu item (added by info plugin)
 * @property {import('../ui.js').SlMenuItem} [menu.profileMenuItem] - User profile menu item (added by user-account plugin)
 * @property {import('../ui.js').SlMenuItem} [menu.logoutMenuItem] - Logout menu item (added by user-account plugin)
 */

/**
 * The main toolbar navigation properties.
 * This documents the structure created by various plugins that add controls to the toolbar.
 * @typedef {object} toolbarPart
 * @property {SlSelect} collection - The selectbox for the collection filter (added by file-selection plugin)
 * @property {SlSelect} variant - The selectbox for the variant filter (added by file-selection plugin)
 * @property {SlSelect} pdf - The selectbox for the pdf document (added by file-selection plugin)
 * @property {SlSelect} xml - The selectbox for the xml document (added by file-selection plugin)
 * @property {SlSelect} diff - The selectbox for the xml-diff document (added by file-selection plugin)
 * @property {UIPart<SlButtonGroup, documentActionsPart>} documentActions - Document action buttons (added by document-actions plugin)
 * @property {UIPart<SlButtonGroup, extractionActionsPart>} extractionActions - Extraction action buttons (added by extraction plugin)
 * @property {UIPart<SlButtonGroup, toolsGroupPart>} toolsGroup - Tools dropdown button group (added by tools plugin)
 * @property {UIPart<import('../ui.js').SlDropdown, toolbarMenuPart>} toolbarMenu - Generic toolbar menu dropdown (added by toolbar plugin)
 * @property {UIPart<SlButton, fileDrawerTriggerPart>} fileDrawerTrigger - File drawer trigger button (added by file-selection-drawer plugin)
 * @property {SlButton} searchBtn - Document search button (added by document-search extension)
 */

class ToolbarPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'toolbar', deps: ['logger'] })
  }

  /** @type {number} */
  #openDropdownCount = 0

  /** @type {WeakSet<Element>} */
  #zIndexFixAttached = new WeakSet()

  /**
   * @param {ApplicationState} state
   * @returns {Promise<void>}
   */
  async install(state) {
    await super.install(state)
    const logger = this.getDependency('logger')
    logger.debug(`Installing plugin "toolbar"`)

    // Create toolbar menu early so dependent plugins can add menu items during their install phase
    const menuElement = createSingleFromTemplate('toolbar-menu-button')
    // Add to toolbar at beginning (will be moved to end in start phase)
    ui.toolbar.insertAdjacentElement('afterbegin', menuElement)
    updateUi()

    logger.debug('Toolbar menu created at beginning of toolbar (will be moved to end in start phase)')
  }

  /**
   * Moves toolbar menu to end of toolbar after all plugins have installed,
   * then initialises the toolbar-wide z-index fix for all dropdowns.
   * @returns {Promise<void>}
   */
  async start() {
    const logger = this.getDependency('logger')
    logger.debug(`Starting plugin "toolbar"`)

    // Move the toolbar menu to the end of the toolbar
    const menuElement = ui.toolbar.toolbarMenu
    ui.toolbar.appendChild(menuElement)
    updateUi()

    this.#initToolbarZIndexAutoFix()

    logger.debug('Toolbar menu moved to end of toolbar')
  }

  // ---------------------------------------------------------------------------
  // Toolbar-wide z-index fix
  //
  // sl-dropdown and sl-select elements inside tool-bar are affected by the
  // toolbar's z-index: 0 stacking context and can appear behind other content
  // when open. The fix elevates the toolbar's z-index via the `dropdown-open`
  // CSS class while any dropdown is open.
  //
  // Listening via event delegation on tool-bar does not work reliably because
  // sl-show / sl-hide events from sl-dropdown elements inside sl-button-group
  // shadow DOM slots do not bubble up consistently. Instead, listeners are
  // attached directly to each sl-dropdown / sl-select element.
  //
  // #initToolbarZIndexAutoFix() scans the toolbar once and then watches for
  // newly added elements with a MutationObserver, so every plugin's dropdowns
  // are covered automatically without any per-plugin wiring.
  // ---------------------------------------------------------------------------

  /**
   * Attach the z-index fix to all current and future sl-dropdown / sl-select
   * elements in the toolbar's light DOM tree.
   */
  #initToolbarZIndexAutoFix = () => {
    const toolbar = ui.toolbar
    toolbar.querySelectorAll('sl-dropdown, sl-select').forEach(this.#attachZIndexFix)
    new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue
          const el = /** @type {Element} */(node)
          if (el.matches('sl-dropdown, sl-select')) this.#attachZIndexFix(el)
          el.querySelectorAll('sl-dropdown, sl-select').forEach(this.#attachZIndexFix)
        }
      }
    }).observe(toolbar, { childList: true, subtree: true })
  }

  /**
   * Attach sl-show / sl-hide listeners to one element. No-op if already attached.
   * @param {Element} element
   */
  #attachZIndexFix = (element) => {
    if (this.#zIndexFixAttached.has(element)) return
    this.#zIndexFixAttached.add(element)
    element.addEventListener('sl-show', () => {
      this.#openDropdownCount++
      element.closest('tool-bar')?.classList.add('dropdown-open')
    })
    element.addEventListener('sl-hide', () => {
      this.#openDropdownCount--
      if (this.#openDropdownCount <= 0) {
        this.#openDropdownCount = 0
        element.closest('tool-bar')?.classList.remove('dropdown-open')
      }
    })
  }
}

export default ToolbarPlugin
