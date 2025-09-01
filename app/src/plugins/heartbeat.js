/**
 * Heartbeat plugin for file locking and offline detection
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 */

import { logger, client, updateState, fileselection, dialog, authentication } from '../app.js'
import ui from '../ui.js'
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
 */
const plugin = {
  name: "heartbeat",
  install
}

export { api, plugin }
export default plugin

// Internal state
let heartbeatInterval = null;
let lockTimeoutSeconds = 60;
let editorReadOnlyState;

/**
 * Runs when the main app starts
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`);
  // Plugin installation complete - actual start happens via API
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
    const filePath = String(ui.toolbar.xml.value);
    const reasonsToSkip = {
      "No user is logged in": state.user === null,
      "No file path specified": !filePath
    };

    for (const reason in reasonsToSkip) {
      if (reasonsToSkip[reason]) {
        logger.debug(`Skipping heartbeat: ${reason}.`);
        return;
      }
    }

    try {
      let heartbeatResponse = null;
      if (!state.editorReadOnly) {
        logger.debug(`Sending heartbeat to server to keep file lock alive for ${filePath}`);
        heartbeatResponse = await client.sendHeartbeat(filePath);
      }

      // Check if file data cache is dirty and only reload if necessary
      // For read-only editors, check cache status separately since no heartbeat was sent
      const cacheStatus = heartbeatResponse?.cache_status || await client.getCacheStatus();
      if (cacheStatus.dirty) {
        logger.debug("File data cache is dirty, reloading file list");
        await fileselection.reload(state, { refresh: true });
      }

      // If we are here, the request was successful. Check if we were offline before.
      if (state.offline) {
        logger.info("Connection restored.");
        notify("Connection restored.");
        await updateState(state, { offline: false, editorReadOnly: editorReadOnlyState });
      }
    } catch (error) {
      console.warn("Error during heartbeat:", error.name, error.message, error.statusCode);
      // Handle different types of errors
      if (error instanceof TypeError) {
        // This is likely a network error (client is offline)
        if (state.offline) {
          // we are still offline
          const message = `Still offline, will try again in ${lockTimeoutSeconds} seconds ...`
          logger.warn(message)
          notify(message)
          return
        }
        logger.warn("Connection lost.");
        notify(`Connection to the server was lost. Will retry in ${lockTimeoutSeconds} seconds.`, "warning");
        editorReadOnlyState = state.editorReadOnly
        await updateState(state, { offline: true, editorReadOnly: true });
      } else if (error.statusCode === 409 || error.statusCode === 423) {
        // Lock was lost or taken by another user
        logger.critical("Lock lost for file: " + filePath);
        dialog.error("Your file lock has expired or was taken by another user. To prevent data loss, please save your work to a new file. Further saving to the original file is disabled.");
        await updateState(state, { editorReadOnly: true });
      } else if (error.statusCode === 504) {
        logger.warn("Temporary connection failure, will try again...")
      } else if (error.statusCode === 403) {
        notify("You have been logged out")
        authentication.logout()
      } else {
        // Another server-side error occurred
        if (state.webdavEnabled) {
          logger.error("An unexpected server error occurred during heartbeat. Disabling WebDAV features.", error);
          dialog.error("An unexpected server error occurred. File synchronization has been disabled for safety.");
          await updateState(state, { webdavEnabled: false });
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