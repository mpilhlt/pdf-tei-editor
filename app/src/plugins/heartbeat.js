/**
 * Heartbeat plugin for file locking and offline detection
 */

/** 
 * @import { ApplicationState, Plugin } from '../app.js' 
 */
import ui from '../ui.js'
import { logger, client, updateState, dialog, authentication } from '../app.js'
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

/** @type {ApplicationState} */
let currentState;

/**
 * Runs when the main app starts
 * @param {ApplicationState} state
 */
async function install(state) {
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
function start(state, timeoutSeconds = 60) {
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
      // Only send heartbeat lock refresh if we're in edit mode
      if (!currentState.editorReadOnly) {
        logger.debug(`Sending heartbeat to server to keep file lock alive for ${filePath}`);
        await client.sendHeartbeat(filePath);
      } else {
        // In read-only mode, skip heartbeat - no lock to maintain
        logger.debug(`Read-only mode: skipping heartbeat for ${filePath}`);
        return;
      }

      // If we are here, the request was successful. Check if we were offline before.
      if (currentState.offline) {
        logger.info("Connection restored.");
        notify("Connection restored.");
        await updateState({ offline: false, editorReadOnly: editorReadOnlyState });
      }
    } catch (error) {
      console.warn("Error during heartbeat:", error.name, String(error), error.statusCode);
      // Handle different types of errors
      if (error instanceof TypeError) {
        // This is likely a network error (client is offline)
        if (currentState.offline) {
          // we are still offline
          const message = `Still offline, will try again in ${lockTimeoutSeconds} seconds ...`
          logger.warn(message)
          notify(message)
          return
        }
        logger.warn("Connection lost.");
        notify(`Connection to the server was lost. Will retry in ${lockTimeoutSeconds} seconds.`, "warning");
        editorReadOnlyState = currentState.editorReadOnly
        await updateState({ offline: true, editorReadOnly: true });
      } else if (error.statusCode === 409 || error.statusCode === 423) {
        // Lock conflict - either lost lock or file locked by another user
        // Only show error dialog if we were in edit mode (i.e., we actually had the lock and lost it)
        // Re-check editorReadOnly state in case it was updated since heartbeat started
        const currentReadOnlyState = currentState?.editorReadOnly || false;
        if (!currentReadOnlyState) {
          logger.critical("Lock lost for file: " + filePath);
          dialog.error("Your file lock has expired or was taken by another user. To prevent data loss, please save your work to a new file. Further saving to the original file is disabled.");
          await updateState({ editorReadOnly: true });
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
        if (currentState.webdavEnabled) {
          logger.error("An unexpected server error occurred during heartbeat. Disabling WebDAV features.", error);
          dialog.error("An unexpected server error occurred. File synchronization has been disabled for safety.");
          await updateState({ webdavEnabled: false });
        }
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
    client.releaseLock(filePath);
  }
}