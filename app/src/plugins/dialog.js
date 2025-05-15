/**
 * This application plugin implements a dialog registered as the "diaolog" property of the app
 */

import { SlButton, SlDialog, appendHtml } from '../ui.js'
import ui from '../ui.js'

/** @import { ApplicationState } from '../app.js' */

// Plugin API
const api = {
  info,
  error
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
 * @property {SlButton} closeBtn
 */

const dialogHtml = `
<sl-dialog name="dialog" label="Dialog" class="dialog-width" style="--width: 50vw;">
  <div>
    <span name="message"></span>
    <sl-button name="closeBtn" slot="footer" variant="primary">Close</sl-button>
  <div>
</sl-dialog>
`

//
// implementation
//

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} app The main application
 */
function install(app) {
  appendHtml(dialogHtml)
  ui.dialog.closeBtn.addEventListener('click', () => ui.dialog.self.hide());
}

/**
 * Shows an informational dialog
 * @param {string} message 
 */
function info(message) {
  ui.dialog.self.setAttribute("label", "Information");
  ui.dialog.message.innerHTML = message
  ui.dialog.self.show()
}

/**
 * Shows an error dialog
 * @param {string} message 
 */
function error(message) {
  ui.dialog.self.setAttribute("label", "Error");
  ui.dialog.message.innerHTML = message
  ui.dialog.self.show()
}