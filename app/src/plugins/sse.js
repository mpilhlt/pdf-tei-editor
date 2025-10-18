/**
 * This implements Server-Sent Events (SSE) connection management
 */

/** 
 * @import { ApplicationState } from '../state.js' 
 */
import { logger } from '../app.js'

/**
 * plugin API
 */
const api = {
  /**
   * @param {string} type
   * @param {(event: MessageEvent) => void} listener
   */
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
  /**
   * @param {string} type
   * @param {(event: MessageEvent) => void} listener
   */
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
  },
  get reconnectAttempts() {
    return reconnectAttempts
  },
  /**
   * Force a reconnection attempt
   */
  reconnect() {
    if (cachedSessionId) {
      logger.info('Manual reconnection requested');
      cleanupConnection();
      establishConnection(cachedSessionId);
    } else {
      logger.warn('Cannot reconnect: no cached session ID');
    }
  }
}

/**
 * component plugin
 */
const plugin = {
  name: "sse",
  install,
  ready,
  state: {
    update
  }
}

/**
 * @type {ApplicationState}
 */
let currentState;

/** @type {EventSource | null} */
let eventSource = null;

/** @type {string | null} */
let cachedSessionId = null;

/** @type {Record<string, ((event: MessageEvent) => void)[]>} */
let queuedListeners = {};

/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimeout = null;

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_INTERVAL = 2000; // Start with 2 seconds

let appStarted = false; // Track if app startup is complete

export { api, plugin }
export default plugin

/**
 * @param {ApplicationState} state
 */
async function install(state){
  currentState = state
  logger.debug(`Installing plugin "${plugin.name}"`)
}

/**
 * @param {ApplicationState} state
 */
async function update(state) {
  currentState = state;
  const { user, sessionId } = state;

  // Close existing connection if the session ID has changed or user logged out
  if (eventSource && (sessionId !== cachedSessionId || !user)) {
    logger.debug('Closing SSE connection due to session change or logout.');
    cleanupConnection();
  }

  // Open a new connection if user is logged in and there's no active connection
  // But only after app startup is complete (appStarted flag set by ready())
  if (user && sessionId && !eventSource && appStarted) {
    establishConnection(sessionId);
  }
}

/**
 * Called when app startup is complete
 */
async function ready() {
  appStarted = true;
  // If user is already authenticated, establish connection now
  if (!eventSource && currentState.sessionId) {
    logger.debug('App ready, SSE is connecting...');
    establishConnection(currentState.sessionId);
  }
}

/**
 * Establish SSE connection with retry logic
 * @param {string} sessionId 
 */
function establishConnection(sessionId) {
  logger.debug(`Establishing SSE connection with session ID ${sessionId} (attempt ${reconnectAttempts + 1})`);

  const url = `/api/v1/sse/subscribe?sessionId=${sessionId}`;
  eventSource = new EventSource(url);
  cachedSessionId = sessionId;

  eventSource.onopen = () => {
    logger.info('SSE connection established successfully');
    reconnectAttempts = 0; // Reset reconnection attempts on successful connection
    
    // Clear any pending reconnection timeout
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
  };

  // Add any queued listeners
  Object.keys(queuedListeners).forEach(type => {
    queuedListeners[type].forEach(/** @param {(event: MessageEvent) => void} listener */ listener => {
      eventSource?.addEventListener(type, listener);
    });
  });

  eventSource.onerror = (_event) => {
    const readyState = eventSource ? eventSource.readyState : 'unknown';
    const errorMsg = `EventSource failed (readyState: ${readyState})`;

    // Provide more detailed error information
    if (readyState === EventSource.CONNECTING) {
      logger.warn(`${errorMsg} - Connection attempt failed`);
    } else if (readyState === EventSource.CLOSED) {
      logger.warn(`${errorMsg} - Connection was closed`);
    } else {
      logger.error(`${errorMsg} - Unexpected error`);
    }

    // Close the connection
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }

    // Attempt reconnection if we haven't exceeded the limit
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = RECONNECT_INTERVAL * Math.pow(2, reconnectAttempts); // Exponential backoff
      reconnectAttempts++;
      
      logger.log(`Attempting to reconnect in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
      
      reconnectTimeout = setTimeout(() => {
        if (cachedSessionId) { // Only reconnect if we still have a session
          establishConnection(cachedSessionId);
        }
      }, delay);
    } else {
      logger.error(`Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) exceeded. SSE connection abandoned.`);
      cachedSessionId = null;
      reconnectAttempts = 0;
    }
  };

  // Clear queued listeners after adding them (but keep the reference for new connections)
  const currentQueuedListeners = { ...queuedListeners };
  queuedListeners = {};
  
  // Re-add listeners for reconnections
  Object.keys(currentQueuedListeners).forEach(type => {
    currentQueuedListeners[type].forEach(/** @param {(event: MessageEvent) => void} listener */ listener => {
      api.addEventListener(type, listener);
    });
  });

  // Standard message channels
  eventSource.addEventListener('updateStatus', /** @param {MessageEvent} evt */ evt => {
    logger.log('SSE Status Update:' + evt.data)
  });
}

/**
 * Clean up SSE connection and cancel any pending reconnections
 */
function cleanupConnection() {
  // Cancel any pending reconnection
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  
  // Close the connection
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  
  // Reset state
  cachedSessionId = null;
  reconnectAttempts = 0;
  
  logger.debug('SSE connection cleaned up');
}

