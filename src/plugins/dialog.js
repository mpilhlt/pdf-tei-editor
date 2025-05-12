/**
 * This application plugin implements a dialog registered as the "diaolog" property of the app
 */

import { SlButton, SlDialog } from '../ui.js'
import ui from '../ui.js'

/** @import { ApplicationState } from '../app.js' */

/**
 * @typedef {object} dialogComponent
 * @property {SlDialog} self
 * @property {HTMLSpanElement} message
 * @property {SlButton} closeBtn
 */

const html = `
<sl-dialog label="Dialog" class="dialog-width" name="dialog" style="--width: 50vw;">
  <span name="message"></span>
  <sl-button slot="footer" name="close" variant="primary">Close</sl-button>
</sl-dialog>
`

// define the component with its own API
const api = {
  info,
  error
}

const plugin = {
  name: "dialog",
  install
}

export { api, plugin }
export default plugin

//
// implementation
//


/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} app The main application
 */
function install(app) {
  const elem = document.createElement("div");
  document.body.appendChild(elem);
  elem.innerHTML = html.trim();
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