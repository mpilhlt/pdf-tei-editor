/**
 * This implements a modal window with the end-user documentation taken from the "docs" folder
 * in the app root. The documentation is written in markdown and converted to HTML using
 * the markdown-it library. Links to local documentation are intercepted and loaded into the dialog.
 * Links to external resources are opened in a new browser tab.
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
  goHome,
  goForward,
  close
}

/**
 * Plugin object
 */
const plugin = {
  name: "info",
  deps: ['authentication'],
  install
}

export { api, plugin }
export default plugin

//
// UI
//

/**
 * Help Window
 * @typedef {object} infoDialogPart
 * @property {SlDialog} self
 * @property {HTMLDivElement} content
 * @property {SlButton} backBtn
 * @property {SlButton} homeBtn
 * @property {SlButton} forwardBtn
 * @property {SlButton} editGitHubBtn
 * @property {SlButton} closeBtn
 */

/**
 * @typedef {object} toolbarInfoBtn
 * @property {SlButton} self
 */
//
// Implementation
//

/**
 * The markdown renderer
 * @see https://github.com/markdown-it/markdown-it
 * @type {MarkdownIt}
 */
let md; 
const localDocsBasePath = "../../docs"
const remoteDocsBasePath = "https://raw.githubusercontent.com/mpilhlt/pdf-tei-editor/refs/heads/main/docs"
const githubEditBasePath = "https://github.com/mpilhlt/pdf-tei-editor/edit/main/docs"

/**
 * Checks if online connectivity is available with a short timeout
 * @param {number} timeout - Timeout in milliseconds (default: 3000)
 * @returns {Promise<boolean>}
 */
async function checkOnlineConnectivity(timeout = 3000) {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)
    
    const response = await fetch(`${remoteDocsBasePath}/index.md`, {
      method: 'HEAD',
      signal: controller.signal,
      cache: 'no-cache'
    })
    
    clearTimeout(timeoutId)
    return response.ok
  } catch (error) {
    return false
  }
}

/**
 * Navigation history for the back button
 * @type {string[]}
 */
let navigationHistory = []

/**
 * Forward history for the forward button
 * @type {string[]}
 */
let forwardHistory = []

/**
 * Currently displayed page for GitHub editing
 * @type {string}
 */
let currentPage = 'index.md'

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} state The main application
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)
  // add the component html
  await createHtmlElements('info-dialog.html', document.body)
  ui.infoDialog.closeBtn.addEventListener('click', () => ui.infoDialog.hide());
  ui.infoDialog.backBtn.addEventListener('click', goBack);
  ui.infoDialog.homeBtn.addEventListener('click', goHome);
  ui.infoDialog.forwardBtn.addEventListener('click', goForward);
  ui.infoDialog.editGitHubBtn.addEventListener('click', () => {
    const githubUrl = `${githubEditBasePath}/${currentPage}`
    window.open(githubUrl, '_blank')
  });

  // add About button to login dialog footer (left side)
  const aboutButton = (await createHtmlElements('about-button.html'))[0]
  aboutButton.addEventListener('click', () => api.open())
  
  // Insert the About button before the Login button
  ui.loginDialog.insertBefore(aboutButton, ui.loginDialog.submit)
  updateUi()

  // add a button to the command bar to show dialog
  const button = (await createHtmlElements('info-toolbar-button.html'))[0]
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
  forwardHistory = []
  updateNavigationButtons()
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
  if (addToHistory && (navigationHistory.length === 0 || navigationHistory[navigationHistory.length - 1] !== mdPath)) {
    navigationHistory.push(mdPath)
    // Clear forward history when navigating to a new page
    forwardHistory = []
    updateNavigationButtons()
  }
  
  // Update current page for GitHub editing
  currentPage = mdPath
  
  // remove existing content
  ui.infoDialog.content.innerHTML = ""
  
  // load markdown 
  let markdown
  let isOnline = false
  
  try {
    // First, try to load from remote if online
    isOnline = await checkOnlineConnectivity()
    if (isOnline) {
      logger.debug(`Loading documentation from remote: ${mdPath}`)
      markdown = await (await fetch(`${remoteDocsBasePath}/${mdPath}`)).text()
    } else {
      throw new Error("No online connectivity")
    }
  } catch(error) {
    // Fallback to local filesystem
    try {
      logger.debug(`Falling back to local documentation: ${mdPath}`)
      markdown = await (await fetch(`${localDocsBasePath}/${mdPath}`)).text()
    } catch(localError) {
      dialog.error(`Failed to load documentation: ${localError.message}`)
      return 
    }
  }
  
  // convert to html
  const html = md.render(markdown)
    // replace local links with api calls
    .replaceAll(
      /(<a\s+.*?)href=(["'])((?!https?:\/\/|\/\/|#).*?)\2(.*?>)/g, 
      `$1href="#" onclick="appInfo.load('$3'); return false"$4`
    )
    // add prefix to relative image source links - use remote or local based on connectivity
    .replaceAll(/src="(\.\/)?images\//g, isOnline ? 
      `src="${remoteDocsBasePath}/images/` : 
      'src="docs/images/')
    // open remote links in new tabs
    .replaceAll(/(href="http)/g, `target="_blank" $1`)
    // remove comment tags that mask the <sl-icon> tags in the markdown
    .replaceAll(/<!--|-->/gs, '') 


  await createHtmlElements(html, ui.infoDialog.content)
}


/**
 * Goes back to the previous page in navigation history
 */
function goBack() {
  if (navigationHistory.length > 1) {
    // Add current page to forward history
    const currentPage = navigationHistory.pop()
    forwardHistory.push(currentPage)
    // Load the previous page without adding to history
    const previousPage = navigationHistory[navigationHistory.length - 1]
    load(previousPage, false)
    updateNavigationButtons()
  }
}

/**
 * Goes to the home page (index.md)
 */
function goHome() {
  load('index.md')
}

/**
 * Goes forward to the next page in forward history
 */
function goForward() {
  if (forwardHistory.length > 0) {
    // Get the next page from forward history
    const nextPage = forwardHistory.pop()
    // Load the next page and add to history
    load(nextPage, true)
    updateNavigationButtons()
  }
}

/**
 * Updates the navigation button states based on history
 */
function updateNavigationButtons() {
  if (ui.infoDialog && ui.infoDialog.backBtn && ui.infoDialog.forwardBtn) {
    ui.infoDialog.backBtn.disabled = navigationHistory.length <= 1
    ui.infoDialog.forwardBtn.disabled = forwardHistory.length === 0
  }
}

/**
 * Closes the prompt editor
 */
function close() {
  ui.promptEditor.hide()
}

