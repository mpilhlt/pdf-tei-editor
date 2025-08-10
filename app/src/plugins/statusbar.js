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

let eventSource = null;
let cachedSessionId = null;

export { api, plugin }
export default plugin

/** 
 * @param {ApplicationState} state 
 */
async function install(state){
  logger.debug(`Installing plugin "${plugin.name}"`)
}

/**
 * @param {ApplicationState} state 
 */
async function update(state) {
  const { user, sessionId } = state;

  // Close existing connection if the session ID has changed or user logged out
  if (eventSource && (sessionId !== cachedSessionId || !user)) {
    logger.debug('Closing SSE connection due to session change or logout.');
    eventSource.close();
    eventSource = null;
    cachedSessionId = null;
    removeMessage('xml', 'sse-status');
  }

  // Open a new connection if user is logged in and there's no active connection
  if (user && sessionId && !eventSource) {
    logger.debug(`User is logged in, subscribing to SSE with session ID ${sessionId}.`);
    const url = `/sse/subscribe?session_id=${sessionId}`;
    eventSource = new EventSource(url);
    cachedSessionId = sessionId;
    let messageTimeout = null
    eventSource.addEventListener('updateStatus', (event) => {
      addMessage(event.data, 'xml', 'sse-status')
      if (messageTimeout) {
        clearTimeout(messageTimeout)
      }
      messageTimeout = setTimeout(() => removeMessage('xml','sse-status'), 5000)
    });

    eventSource.onerror = (err) => {
      logger.error("EventSource failed:", err);
      if (eventSource) {
        eventSource.close();
      }
      eventSource = null;
      cachedSessionId = null;
    };
  }
}

/**
 * Returns the status bar DIV of either the PDF viewer or the XML editor
 * @param {string} type 
 * @returns {HTMLDivElement}
 */
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