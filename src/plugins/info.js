/**
 * This implements a popup dialog to display information about the applicatioon
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import MarkdownIt from 'markdown-it'
 */
import ui from '../ui.js'
import { appendHtml, SlDialog, SlButton } from '../ui.js'
import { dialog } from '../app.js'

import markdownit from 'markdown-it'

/**
 * plugin API
 */
const api = {
  open,
  load,
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
 * @property {HTMLDivElement} content
 * @property {SlButton} closeBtn
 */

// editor dialog
const infoHtml = `
<sl-dialog name="infoDialog" label="Information" class="dialog-big">
  <div>
    <div name="content"></div>
    <sl-button name="closeBtn" slot="footer" variant="primary">Close</sl-button>
  <div>
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
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state The main application
 */
async function install(state) {
  // add the component html
  appendHtml(infoHtml)
  ui.infoDialog.closeBtn.addEventListener('click', () => ui.infoDialog.self.hide());

  // add a button to the command bar to show dialog with prompt editor
  const button = appendHtml(buttonHtml, ui.toolbar.self)[0]
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
  load('index.md')
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
 * Loads markdowm and converts it to HTML, replacing links to local content to calls to this method
 * @param {string} mdPath The local path to the md file, relative to the "docs" dir
 */
async function load(mdPath){
  ui.infoDialog.content.innerHTML = ""
  let markdown
  // load content 
  try {
    markdown = await (await fetch(`${docsBasePath}/${mdPath}`)).text()
  } catch(error) {
    dialog.error(error.message)
    return 
  }
  
  console.log(markdown)
  // convert to html, replacing local links with api calls
  // regex written by Gemini 2.5 Flash 
  const regex = /(<a\s+.*?)href=(["'])((?!https?:\/\/|\/\/|#|mailto:|tel:|data:).*?)\2(.*?>)/g
  const replacement = `$1href="#" onclick="appInfo.load('${docsBasePath}/$3'); return false"$4`
  const html = md.render(markdown).replaceAll(regex, replacement)
  console.log(html)
  appendHtml(html, ui.infoDialog.content)
}



/**
 * Closes the prompt editor
 */
function close() {
  ui.promptEditor.self.hide()
}

