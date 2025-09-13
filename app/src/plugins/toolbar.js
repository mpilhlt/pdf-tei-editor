/**
 * Toolbar Plugin
 * 
 * This plugin documents the toolbar component structure and will eventually
 * provide a real implementation similar to the statusbar system.
 * Currently, the toolbar is just a container div where other plugins add their controls.
 */

/** 
 * @import { ApplicationState } from '../state.js' 
 * @import { SlSelect, SlButton, SlButtonGroup, UIPart } from '../ui.js'
 * @import { documentActionsPart, teiServicesPart } from './services.js'
 * @import { extractionActionsPart } from './extraction.js'
 * @import { fileDrawerTriggerPart } from './file-selection-drawer.js'
 */

import { logger, hasStateChanged } from '../app.js'
import ui from '../ui.js'

//
// UI Parts
//

/**
 * The main toolbar navigation properties.
 * This documents the structure created by various plugins that add controls to the toolbar.
 * @typedef {object} toolbarPart
 * @property {SlSelect} variant - The selectbox for the variant filter (added by file-selection plugin)
 * @property {SlSelect} pdf - The selectbox for the pdf document (added by file-selection plugin)  
 * @property {SlSelect} xml - The selectbox for the xml document (added by file-selection plugin)
 * @property {SlSelect} diff - The selectbox for the xml-diff document (added by file-selection plugin)
 * @property {UIPart<SlButtonGroup, documentActionsPart>} documentActions - Document action buttons (added by services plugin)
 * @property {UIPart<SlButtonGroup, teiServicesPart>} teiActions - TEI service buttons (added by services plugin)
 * @property {UIPart<SlButtonGroup, extractionActionsPart>} extractionActions - Extraction action buttons (added by extraction plugin)
 * @property {SlButton} logoutButton - The logout button (added by authentication plugin)
 * @property {UIPart<SlButton, fileDrawerTriggerPart>} fileDrawerTrigger - File drawer trigger button (added by file-selection-drawer plugin)
 */

/**
 * plugin object
 */
const plugin = {
  name: "toolbar",
  install
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
  // the toolbar is defined in index.html, no need to install it
}
