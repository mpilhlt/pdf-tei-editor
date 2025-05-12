/**
 * This application plugin implements a dialog registered as the "diaolog" property of the app
 */


const html = `
<sl-dialog label="Dialog" class="dialog-width" name="dialog" style="--width: 50vw;">
  <span id="dialog-text"></span>
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

let dialog

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {PdfTeiEditor} app The main application
 */
function install(app) {
  const elem = document.createElement("div");
  document.body.appendChild(elem);
  elem.innerHTML = html.trim();
  dialog = elem.firstChild
  const button = dialog.querySelector('sl-button[name="close"]');
  button.addEventListener('click', () => dialog.hide());
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