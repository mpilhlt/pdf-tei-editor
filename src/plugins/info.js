/**
 * This implements a popup dialog to display information about the applicatioon
 */

/** @import { ApplicationState } from '../app.js' */
import ui from '../ui.js'
import { appendHtml, SlDialog, SlButton } from '../ui.js'
import markdownit from 'markdown-it'

/**
 * plugin API
 */
const api = {
  open,
  close
}

/**
 * Plugin object
 */
const plugin = {
  name: "info",
  install
}

export { api, plugin }
export default plugin

//
// UI
//

/**
 * Help Dialog
 * @typedef {object} infoDialogComponent
 * @property {SlDialog} self
 * @property {SlButton} closeBtn
 */

// editor dialog
const infoHtml = `
<sl-dialog name="infoDialog" label="Information" class="dialog-big">
</sl-dialog>
`

/**
 * @typedef {object} toolbarInfoBtn
 * @property {SlButton} self
 */
// button for toolbar
const buttonHtml = `
<sl-tooltip content="Information and help">
  <sl-button name="editInstructions" size="small">
    <sl-icon name="info-circle"></sl-icon>
  </sl-button>
</sl-tooltip>
`
//
// Implementation
//

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state The main application
 */
async function install(state) {
  // add prompt editor component
  appendHtml(infoHtml)

  // add a button to the command bar to show dialog with prompt editor
  const button = appendHtml(buttonHtml, ui.toolbar.self)[0]
  button.addEventListener("click", () => api.open())

  // load content 
  const markdown = await (await fetch('../../docs/index.md')).text()
  const html = markdownit().render(markdown);
  appendHtml(html, ui.infoDialog.self)
}

// API

/**
 * Opens the prompt editor dialog
 * todo this needs to always reload the data since it might have changed on the server
 */
async function open() {
  ui.infoDialog.self.show()
}



/**
 * Closes the prompt editor
 */
function close() {
  ui.promptEditor.self.hide()
}

