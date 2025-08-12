/**
 * This implements Server-Sent Events (SSE) connection management
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 */
import { logger } from '../app.js'

/**
 * plugin API
 */
const api = {
  addEventListener: (type, listener) => {
    if (eventSource) {
      eventSource.addEventListener(type, listener)
    } else {
      // Queue listeners for when connection is established
      if (!queuedListeners[type]) {
        queuedListeners[type] = []
      }
      queuedListeners[type].push(listener)
    }
  },
  removeEventListener: (type, listener) => {
    if (eventSource) {
      eventSource.removeEventListener(type, listener)
    }
  },
  get readyState() {
    return eventSource ? eventSource.readyState : EventSource.CLOSED
  },
  get url() {
    return eventSource ? eventSource.url : null
  }
}

/**
 * component plugin
 */
const plugin = {
  name: "sse",
  install,
  state: {
    update
  }
}

let eventSource = null;
let cachedSessionId = null;
let queuedListeners = {};

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
  }

  // Open a new connection if user is logged in and there's no active connection
  if (user && sessionId && !eventSource) {
    logger.debug(`User is logged in, subscribing to SSE with session ID ${sessionId}.`);
    const url = `/sse/subscribe?session_id=${sessionId}`;
    eventSource = new EventSource(url);
    cachedSessionId = sessionId;

    // Add any queued listeners
    Object.keys(queuedListeners).forEach(type => {
      queuedListeners[type].forEach(listener => {
        eventSource.addEventListener(type, listener);
      });
    });
    queuedListeners = {};

    eventSource.onerror = (err) => {
      logger.error("EventSource failed:", err);
      if (eventSource) {
        eventSource.close();
      }
      eventSource = null;
      cachedSessionId = null;
    };
    eventSource.addEventListener('updateStatus', evt => {
      logger.info(evt.data)
    })
  }
}

