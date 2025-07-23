/**
 * This implements the application statusbar
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlSelect } from '../ui.js'
 */
import ui from '../ui.js'
import { createHtmlElements, updateUi } from '../ui.js'
import { logger } from '../app.js'

/**
 * plugin API
 */
const api = {
  addMessage,
  removeMessage
}

/**
 * component plugin
 */
const plugin = {
  name: "statusbar",
  install,
  state: {
    update
  }
}

export { api, plugin }
export default plugin


/**
 * @param {ApplicationState} state 
 */
async function install(state) {


}

/**
 * @param {ApplicationState} state 
 */
async function update(state) {

}

function getStatusBar(type) {
  if (!["xml","pdf"].includes(type)){
    throw new Error(`${type} must be "xml" or "pdf"`)
  }
  return type === "xml" ? ui.statusBar.statusMessageXml : ui.statusBar.statusMessagePdf
}

/**
 * Adds/replaces a message to the statusbar with a given id
 * @param {string} message The message to display
 * @param {string} type Either "pdf" or "xml"
 * @param {string} id The id of the message (by which it can be removed)
 */
function addMessage(message, type, id) {
  const statusbar = getStatusBar(type)
  const span = statusbar.querySelector(`[name="${id}"]`) || document.createElement('span')
  span.setAttribute('name', id) 
  span.innerHTML = message
  statusbar.append(span)
}

/**
 * Removes a message to the statusbar identified by its id
 * @param {string} type Either "pdf" or "xml"
 * @param {string} id The id of the message (by which it can be removed)
 * @throws {Error} if no message(s) with that id can be found
 */
function removeMessage(type, id) {
  const statusbar = getStatusBar(type)
  const span = statusbar.querySelector(`[name="${id}"]`)
  if (span) {
    statusbar.removeChild(span)
  } else {
    logger.warn(`${type} statusbar does not contain a message with id ${id}`)
  }
}