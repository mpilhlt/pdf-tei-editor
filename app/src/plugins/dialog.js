/**
 * This application plugin implements a dialog registered as the "diaolog" property of the app
 */

import { SlButton, SlDialog, createHtmlElements, updateUi } from '../ui.js'
import ui from '../ui.js'
import { logger } from '../app.js'

/** @import { ApplicationState } from '../app.js' */

// Plugin API
const api = {
  info,
  error,
  success
}

// Plugin object
const plugin = {
  name: "dialog",
  install
}

export { api, plugin }
export default plugin

//
// UI
//

/**
 * @typedef {object} dialogComponent
 * @property {SlDialog} self
 * @property {HTMLSpanElement} message
 * @property {HTMLDivElement} icon
 * @property {SlButton} closeBtn
 */

//
// implementation
//

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} app The main application
 */
async function install(app) {
  logger.debug(`Installing plugin "${plugin.name}"`)
  await createHtmlElements("dialog.html", document.body)
  updateUi();
  ui.dialog.closeBtn.addEventListener('click', () => ui.dialog.self.hide());
}

/**
 * Shows an informational dialog
 * @param {string} message 
 */
function info(message) {
  ui.dialog.self.setAttribute("label", "Information");
  ui.dialog.icon.innerHTML = `<sl-icon name="info-circle" style="color: var(--sl-color-primary-500);"></sl-icon>`;
  ui.dialog.message.innerHTML = message
  ui.dialog.self.show()
}

/**
 * Shows an error dialog
 * @param {string} message 
 */
function error(message) {
  ui.dialog.self.setAttribute("label", "Error");
  ui.dialog.icon.innerHTML = `<sl-icon name="exclamation-triangle" style="color: var(--sl-color-danger-500);"></sl-icon>`;
  ui.dialog.message.innerHTML = message
  ui.dialog.self.show()
}

/**
 * Shows a success dialog
 * @param {string} message 
 */
function success(message) {
  ui.dialog.self.setAttribute("label", "Success");
  ui.dialog.icon.innerHTML = `<sl-icon name="check-circle" style="color: var(--sl-color-success-500);"></sl-icon>`;
  ui.dialog.message.innerHTML = message
  ui.dialog.self.show()
}
