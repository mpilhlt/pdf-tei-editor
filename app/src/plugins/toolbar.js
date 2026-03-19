/**
 * Toolbar Plugin
 * 
 * This plugin documents the toolbar component structure and will eventually
 * provide a real implementation similar to the statusbar system.
 * Currently, the toolbar is just a container div where other plugins add their controls.
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlSelect, SlButton, SlButtonGroup, SlDropdown, UIPart } from '../ui.js'
 * @import { documentActionsPart } from './document-actions.js'
 * @import { extractionActionsPart } from './extraction.js'
 * @import { fileDrawerTriggerPart } from './file-selection-drawer.js'
 * @import { toolsGroupPart } from './tools.js'
 */

import { logger } from '../app.js'
import ui, { updateUi } from '../ui.js'
import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js'

// Register template
await registerTemplate('toolbar-menu-button', 'toolbar-menu-button.html');

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

/**
 * plugin object
 */
const plugin = {
  name: "toolbar",
  install,
  start
}

export { plugin }
export default plugin

//
// Implementation
//

/**
 * @param {ApplicationState} state
 * @returns {Promise<void>}
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // Create toolbar menu early so dependent plugins can add menu items during their install phase
  const menuElement = createSingleFromTemplate('toolbar-menu-button');
  // Add to toolbar at beginning (will be moved to end in start phase)
  ui.toolbar.insertAdjacentElement("afterbegin", menuElement);
  updateUi();

  logger.debug('Toolbar menu created at beginning of toolbar (will be moved to end in start phase)')
}

/**
 * Start function - moves toolbar menu to end of toolbar after all plugins have installed,
 * then initialises the toolbar-wide z-index fix for all dropdowns.
 * @returns {Promise<void>}
 */
async function start() {
  logger.debug(`Starting plugin "${plugin.name}"`)

  // Move the toolbar menu to the end of the toolbar
  const menuElement = ui.toolbar.toolbarMenu;
  ui.toolbar.appendChild(menuElement);
  updateUi();

  _initToolbarZIndexAutoFix();

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
// _initToolbarZIndexAutoFix() scans the toolbar once and then watches for
// newly added elements with a MutationObserver, so every plugin's dropdowns
// are covered automatically without any per-plugin wiring.
// ---------------------------------------------------------------------------

/** @type {number} */
let _openDropdownCount = 0;

/** @type {WeakSet<Element>} */
const _zIndexFixAttached = new WeakSet();

/**
 * Attach the z-index fix to all current and future sl-dropdown / sl-select
 * elements in the toolbar's light DOM tree.
 */
function _initToolbarZIndexAutoFix() {
  const toolbar = ui.toolbar;
  toolbar.querySelectorAll('sl-dropdown, sl-select').forEach(_attachZIndexFix);
  new MutationObserver(mutations => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches('sl-dropdown, sl-select')) _attachZIndexFix(node);
        node.querySelectorAll('sl-dropdown, sl-select').forEach(_attachZIndexFix);
      }
    }
  }).observe(toolbar, { childList: true, subtree: true });
}

/**
 * Attach sl-show / sl-hide listeners to one element. No-op if already attached.
 * @param {Element} element
 */
function _attachZIndexFix(element) {
  if (_zIndexFixAttached.has(element)) return;
  _zIndexFixAttached.add(element);
  element.addEventListener('sl-show', () => {
    _openDropdownCount++;
    element.closest('tool-bar')?.classList.add('dropdown-open');
  });
  element.addEventListener('sl-hide', () => {
    _openDropdownCount--;
    if (_openDropdownCount <= 0) {
      _openDropdownCount = 0;
      element.closest('tool-bar')?.classList.remove('dropdown-open');
    }
  });
}
