/**
 * This implements a popup dialog to display information about the applicatioon
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import MarkdownIt from 'markdown-it'
 */
import ui, { updateUi } from '../ui.js'
import { createHtmlElements, SlDialog, SlButton } from '../ui.js'
import { dialog,logger } from '../app.js'

import markdownit from 'markdown-it'

/**
 * plugin API
 */
const api = {
  open,
  load,
  goBack,
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
 * @typedef {object} infoDialogPart
 * @property {SlDialog} self
 * @property {HTMLDivElement} content
 * @property {SlButton} backBtn
 * @property {SlButton} closeBtn
 */

// editor dialog
const infoHtml = `
<sl-dialog name="infoDialog" label="Information" class="dialog-big">
  <div name="content"></div>
  <sl-button name="backBtn" slot="footer" variant="default" disabled>
    <sl-icon name="arrow-left"></sl-icon>
    Back
  </sl-button>
  <sl-button name="closeBtn" slot="footer" variant="primary">Close</sl-button>
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
 * The markdown renderer
 * @see https://github.com/markdown-it/markdown-it
 * @type {MarkdownIt}
 */
let md; 
const docsBasePath = "../../docs"

/**
 * Navigation history for the back button
 * @type {string[]}
 */
let navigationHistory = []

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state The main application
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)
  // add the component html
  await createHtmlElements(infoHtml, document.body)
  ui.infoDialog.closeBtn.addEventListener('click', () => ui.infoDialog.hide());
  ui.infoDialog.backBtn.addEventListener('click', goBack);

  // add a button to the command bar to show dialog with prompt editor
  const button = (await createHtmlElements(buttonHtml))[0]
  ui.toolbar.append(button)
  updateUi()
  button.addEventListener("click", () => api.open())
  
  // configure markdown parser
  const options = {
    html: true,
    linkify: true,
    typographer: true
  }
  md = markdownit(options);
  
  // @ts-ignore
  window.appInfo = api
}

// API

/**
 * Opens the info dialog
 * todo this needs to always reload the data since it might have changed on the server
 */
async function open() {
  // Reset navigation history when opening the dialog
  navigationHistory = []
  updateBackButton()
  ui.infoDialog.show()
  // Load the index page
  await load('index.md')
}

/**
 * Loads markdowm and converts it to HTML, replacing links to local content to calls to this method
 * @param {string} mdPath The local path to the md file, relative to the "docs" dir
 * @param {boolean} addToHistory Whether to add this page to navigation history (default: true)
 */
async function load(mdPath, addToHistory = true){
  // Add current page to history if we're navigating to a new page
  if (addToHistory && navigationHistory.length === 0 || navigationHistory[navigationHistory.length - 1] !== mdPath) {
    navigationHistory.push(mdPath)
    updateBackButton()
  }
  
  // remove existing content
  ui.infoDialog.content.innerHTML = ""
  
  // load markdown 
  let markdown
  try {
    markdown = await (await fetch(`${docsBasePath}/${mdPath}`)).text()
  } catch(error) {
    dialog.error(error.message)
    return 
  }
  
  // convert to html
  const html = md.render(markdown)
    // replace local links with api calls
    .replaceAll(
      /(<a\s+.*?)href=(["'])((?!https?:\/\/|\/\/|#|mailto:|tel:|data:).*?)\2(.*?>)/g, 
      `$1href="#" onclick="appInfo.load('$3'); return false"$4`
    )
    // open remote links in new tabs
    .replaceAll(/(href="http)/g, `target="_blank" $1`)

  await createHtmlElements(html, ui.infoDialog.content)
}


/**
 * Goes back to the previous page in navigation history
 */
function goBack() {
  if (navigationHistory.length > 1) {
    // Remove current page from history
    navigationHistory.pop()
    // Load the previous page without adding to history
    const previousPage = navigationHistory[navigationHistory.length - 1]
    navigationHistory.pop() // Remove it so load() can add it back
    load(previousPage)
  }
}

/**
 * Updates the back button state based on navigation history
 */
function updateBackButton() {
  if (ui.infoDialog && ui.infoDialog.backBtn) {
    ui.infoDialog.backBtn.disabled = navigationHistory.length <= 1
  }
}

/**
 * Closes the prompt editor
 */
function close() {
  ui.promptEditor.hide()
}

