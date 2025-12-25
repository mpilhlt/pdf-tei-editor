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
 * @import { teiServicesPart } from './services.js'
 * @import { extractionActionsPart } from './extraction.js'
 * @import { fileDrawerTriggerPart } from './file-selection-drawer.js'
 */

import { logger, hasStateChanged } from '../app.js'
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
 * @property {import('../ui.js').SlMenuItem} [menu.gcMenuItem] - Garbage collection menu item (added by filedata plugin, admin only)
 * @property {import('../ui.js').SlMenuItem} [menu.rbacManagerMenuItem] - RBAC manager menu item (added by rbac-manager plugin, admin only)
 * @property {import('../ui.js').SlMenuItem} [menu.configEditorMenuItem] - Config editor menu item (added by config-editor plugin, admin only)
 * @property {import('../ui.js').SlMenuItem} [menu.profileMenuItem] - User profile menu item (added by user-account plugin)
 * @property {import('../ui.js').SlMenuItem} [menu.logoutMenuItem] - Logout menu item (added by user-account plugin)
 */

/**
 * The main toolbar navigation properties.
 * This documents the structure created by various plugins that add controls to the toolbar.
 * @typedef {object} toolbarPart
 * @property {SlSelect} variant - The selectbox for the variant filter (added by file-selection plugin)
 * @property {SlSelect} pdf - The selectbox for the pdf document (added by file-selection plugin)
 * @property {SlSelect} xml - The selectbox for the xml document (added by file-selection plugin)
 * @property {SlSelect} diff - The selectbox for the xml-diff document (added by file-selection plugin)
 * @property {UIPart<SlButtonGroup, documentActionsPart>} documentActions - Document action buttons (added by document-actions plugin)
 * @property {UIPart<SlButtonGroup, teiServicesPart>} teiActions - TEI service buttons (added by services plugin)
 * @property {UIPart<SlButtonGroup, extractionActionsPart>} extractionActions - Extraction action buttons (added by extraction plugin)
 * @property {UIPart<SlButtonGroup, backendPluginsButtonPart>} backendPluginsGroup - Backend plugins dropdown (added by backend-plugins plugin)
 * @property {UIPart<import('../ui.js').SlDropdown, toolbarMenuPart>} toolbarMenu - Generic toolbar menu dropdown (added by toolbar plugin)
 * @property {UIPart<SlButton, fileDrawerTriggerPart>} fileDrawerTrigger - File drawer trigger button (added by file-selection-drawer plugin)
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
 * Start function - moves toolbar menu to end of toolbar after all plugins have installed
 * @returns {Promise<void>}
 */
async function start() {
  logger.debug(`Starting plugin "${plugin.name}"`)

  // Move the toolbar menu to the end of the toolbar
  const menuElement = ui.toolbar.toolbarMenu;
  ui.toolbar.appendChild(menuElement);
  updateUi();

  logger.debug('Toolbar menu moved to end of toolbar')
}
