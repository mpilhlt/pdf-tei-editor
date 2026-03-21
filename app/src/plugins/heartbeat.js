/**
 * Heartbeat plugin for file locking and offline detection
 */

/** 
 * @import { ApplicationState, Plugin } from '../app.js' 
 */
import ui from '../ui.js'
import { app, logger, client, dialog, authentication } from '../app.js'
import { notify } from '../modules/sl-utils.js'

/**
 * Plugin API
 */
const api = {
  start,
  stop
}

/**
 * Component plugin
 * @type {Plugin}
 */
const plugin = {
  name: "heartbeat",
  deps: ["logger", "client", "authentication"],
  install,
  state: {
    update
  }
}

export { api, plugin }
export default plugin

// Internal state
let heartbeatInterval = null;
let lockTimeoutSeconds = 60;
let editorReadOnlyState;
/** Tracks whether the heartbeat detected a client→server connection loss (independent of state.offline) */
let isConnectionLost = false;

/** @type {ApplicationState} */
let currentState;

/**
 * Runs when the main app starts
 * @param {ApplicationState} state
 */
async function install() {
  logger.debug(`Installing plugin "${plugin.name}"`);
  // Plugin installation complete - actual start happens via API
}

/**
 * Handles state updates
 * @param {ApplicationState} state
 */
async function update(state) {
  // Store current state for use in interval callbacks
  currentState = state;
}

/**
 * Starts the heartbeat mechanism
 * @param {ApplicationState} state
 * @param {number} [timeoutSeconds=60] - Heartbeat interval in seconds
 */
function start(_state, timeoutSeconds = 60) {
  if (!Number.isInteger(timeoutSeconds)) {
    throw new Error(`Invalid timeout value: ${timeoutSeconds}`)
  }
  
  if (heartbeatInterval) {
    logger.debug("Heartbeat already running, stopping previous instance");
    stop();
  }
  
  lockTimeoutSeconds = timeoutSeconds;
  logger.debug(`Starting heartbeat with ${lockTimeoutSeconds} second interval`);
  
  const heartbeatFrequency = lockTimeoutSeconds * 1000;

  // Set up cleanup on page unload
  window.addEventListener('beforeunload', stop);

  // Start the heartbeat interval
  heartbeatInterval = setInterval(async () => {
    // Use current state instead of stale state from closure
    if (!currentState) {
      logger.debug("Skipping heartbeat: no current state available");
      return;
    }
    
    const filePath = String(ui.toolbar.xml.value);
    const reasonsToSkip = {
      "Maintenance mode is active": currentState.maintenanceMode,
      "No user is logged in": currentState.user === null,
      "No file path specified": !filePath
    };

    for (const reason in reasonsToSkip) {
      if (reasonsToSkip[reason]) {
        logger.debug(`Skipping heartbeat: ${reason}.`);
        return;
      }
    }

    try {
      if (currentState.editorReadOnly && !isConnectionLost) {
        // Read-only due to lock (not connection loss): no lock to maintain, skip
        logger.debug(`Read-only mode: skipping heartbeat for ${filePath}`);
        return;
      }
      logger.debug(`Sending heartbeat to server${isConnectionLost ? ' (connectivity probe)' : ''} for ${filePath}`);
      await client.sendHeartbeat(filePath);

      // Request succeeded — check if we had a connection loss to recover from
      if (isConnectionLost) {
        isConnectionLost = false;
        logger.info("Connection restored.");
        notify("Connection restored.");
        await app.updateState({ connectionLost: false, editorReadOnly: editorReadOnlyState });
      }
    } catch (error) {
      console.warn("Error during heartbeat:", error.name, String(error), error.statusCode);
      if (error instanceof TypeError) {
        // Network error: browser cannot reach the backend
        if (isConnectionLost) {
          const message = `Still unreachable, will try again in ${lockTimeoutSeconds} seconds ...`
          logger.warn(message)
          notify(message)
          return
        }
        logger.warn("Connection to backend lost.");
        notify(`Connection to the server was lost. Will retry in ${lockTimeoutSeconds} seconds.`, "warning");
        isConnectionLost = true;
        editorReadOnlyState = currentState.editorReadOnly;
        await app.updateState({ connectionLost: true, editorReadOnly: true });
      } else if (error.statusCode === 409 || error.statusCode === 423) {
        // Server responded — connectivity is confirmed.
        // If we had a connection loss, the lock expired during the outage — restore state.
        if (isConnectionLost) {
          isConnectionLost = false;
          logger.info("Connection restored (lock expired during outage).");
          notify("Connection restored.");
          await app.updateState({ connectionLost: false, editorReadOnly: editorReadOnlyState });
          return;
        }
        // Only show error dialog if we were in edit mode (i.e., we actually had the lock and lost it)
        const currentReadOnlyState = currentState?.editorReadOnly || false;
        if (!currentReadOnlyState) {
          logger.critical("Lock lost for file: " + filePath);
          dialog.error("Your file lock has expired or was taken by another user. To prevent data loss, please save your work to a new file. Further saving to the original file is disabled.");
          await app.updateState({ editorReadOnly: true });
        } else {
          // We're in read-only mode, so lock conflicts are expected - just log it
          logger.debug(`Heartbeat received lock conflict for read-only file ${filePath} (expected, not showing error)`);
        }
      } else if (error.statusCode === 404) {
        // File not found - silently skip (file was likely deleted)
        logger.debug(`Heartbeat file not found (${filePath}), skipping. File may have been deleted.`);
        return;
      } else if (error.statusCode === 504) {
        logger.warn("Temporary connection failure, will try again...")
      } else if (error.statusCode === 403) {
        notify("You have been logged out")
        authentication.logout()
      } else {
        // Another server-side error occurred
        logger.error("An unexpected server error occurred during heartbeat.", error);
      }
    }
  }, heartbeatFrequency);
  
  logger.info("Heartbeat started.");
}

/**
 * Stops the heartbeat mechanism
 */
function stop() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    logger.debug("Heartbeat stopped.");
  }
  
  // Release file lock if we have one
  const filePath = ui.toolbar.xml.value;
  if (filePath) {
    client.releaseLock(filePath).catch(() => {});
  }
}