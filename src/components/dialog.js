/**
 * This application plugin implements a dialog registered as the "diaolog" property of the app
 */

import '@shoelace-style/shoelace/dist/components/dialog/dialog.js';
import '@shoelace-style/shoelace/dist/components/button/button.js'

import { app, PdfTeiEditor } from '../app.js'

const html = `
<sl-dialog label="Dialog" class="dialog-width" style="--width: 50vw;">
  <span id="dialog-text"></span>
  <sl-button slot="footer" variant="primary">Close</sl-button>
</sl-dialog>
`

// add dialog to DOM
const elem = document.createElement("div");
document.body.appendChild(elem);
elem.innerHTML = html.trim();
const dialog = elem.firstChild
const button = dialog.querySelector('sl-button[slot="footer"]');
button.addEventListener('click', () => dialog.hide());

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
 * @param {PdfTeiEditor} app The main application
 */
function install(app) {
  app.logger.info("Dialog component installed.")
  app.registerComponent('dialog', api, 'dialog')
}

/**
 * Shows an informational dialog
 * @param {string} message 
 */
function info(message) {
  dialog.setAttribute("label", "Information");
  dialog.querySelector('#dialog-text').innerHTML = message
  dialog.show()
}

/**
 * Shows an error dialog
 * @param {string} message 
 */
function error(message) {
  dialog.setAttribute("label", "Error");
  dialog.textContent = message
  dialog.show()
}