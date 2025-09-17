/**
 * This plugin provides file synchronization functionality with WebDAV servers
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlIcon } from '../ui.js'
 * @import { ResponseType_files_sync } from './client.js'
 */
import ui from '../ui.js'
import {
  updateState, client, logger, fileselection, sse
} from '../app.js'
import { StatusProgress } from '../modules/panels/widgets/status-progress.js'

/**
 * plugin API
 */
const api = {
  syncFiles
}

/**
 * component plugin
 */
const plugin = {
  name: "sync",
  deps: ['services'],
  install,
  state: { update }
}

export { plugin, api }
export default plugin

// Current state for use in event handlers
/** @type {ApplicationState | null} */
let currentState = null

//
// UI
//

// Sync progress widget for XML editor statusbar
/** @type {StatusProgress} */
let syncProgressWidget;
/** @type {HTMLDivElement} */
let syncContainer;
/**@type {SlIcon} */
let syncIcon;

//
// Implementation
//

/**
 * @param {ApplicationState} state
 */
async function install(state) {
  void state; // Unused parameter
  logger.debug(`Installing plugin "${plugin.name}"`)

  // Set up SSE listeners for sync progress and messages
  sse.addEventListener('syncProgress', (event) => {
    const progress = parseInt(event.data)
    // Don't log progress counter to console, only update the progress bar
    if (syncProgressWidget && syncProgressWidget.isConnected) {
      syncProgressWidget.indeterminate = false
      syncProgressWidget.value = progress
    }
  })

  sse.addEventListener('syncMessage', (event) => {
    const message = event.data
    // Log sync messages to console instead of displaying in widget
    logger.debug(`Sync: ${message}`)
  })

  // Create sync progress widget for XML editor statusbar
  syncProgressWidget = new StatusProgress()
  syncProgressWidget.text = ''
  syncProgressWidget.indeterminate = false
  syncProgressWidget.value = 0
  syncProgressWidget.hidePercentage = true

  // Make the progress bar half the default size
  syncProgressWidget.style.minWidth = '40px'
  syncProgressWidget.style.maxWidth = '75px'

  // Create clickable icon element for the progress widget
  // <sl-icon name="arrow-repeat"></sl-icon>
  syncIcon = document.createElement('sl-icon')
  syncIcon.name = 'arrow-repeat'
  syncIcon.style.marginRight = '4px'
  syncIcon.style.cursor = 'pointer'
  syncIcon.title = 'Click to sync files'

  // Add click handler to sync icon to start sync
  syncIcon.addEventListener('click', () => {
    if (currentState) onClickSyncBtn(currentState);
  })

  // Create a container that includes the icon and progress bar
  syncContainer = document.createElement('div')
  syncContainer.style.display = 'flex'
  syncContainer.style.alignItems = 'center'
  syncContainer.appendChild(syncIcon)
  syncContainer.appendChild(syncProgressWidget)

  // Add the sync widget to the XML editor statusbar permanently
  ui.xmlEditor.statusbar.add(syncContainer, 'left', 3)

}

/**
 * Invoked on application state change
 * @param {ApplicationState} state
 */
async function update(state) {
  // Store current state for use in event handlers
  currentState = state;
  
  // TODO implement `hidden` property on widgets
  syncContainer.style.display = state.webdavEnabled ? 'flex' : 'none'
}

/**
 * Synchronizes the files on the server with the WebDAV backend, if so configured
 * @param {ApplicationState} state
 * @returns {Promise<ResponseType_files_sync|false>}
 */
async function syncFiles(state) {
  if (state.webdavEnabled) {
    logger.debug("Synchronizing files on the server")
    syncIcon.classList.add("rotating")
    // Reset progress widget for new sync
    if (syncProgressWidget) {
      syncProgressWidget.indeterminate = true
      syncProgressWidget.value = 0
    }
    try {
      const summary = await client.syncFiles()
      if ('skipped' in summary && summary.skipped) {
        logger.debug("Sync skipped - no changes detected")
      } else {
        logger.log(`Sync completed: ${JSON.stringify(summary)}`)
      }
      return summary
    } finally {
      syncIcon.classList.remove("rotating")
      // Reset progress widget to 0% after sync completion
      if (syncProgressWidget) {
        syncProgressWidget.indeterminate = false
        syncProgressWidget.value = 0
      }
    }
  }
  return false
}

/**
 * Event handler for sync button click
 * @param {ApplicationState} state
 */
async function onClickSyncBtn(state) {
  let summary // Used in try/finally for manual sync result

  // Store original read-only state to restore later
  const originalReadOnly = state.editorReadOnly

  // Set editor to read-only during sync to prevent conflicts
  await updateState({ editorReadOnly: true })
  try {
    summary = await syncFiles(state)
  } catch (e) {
    throw e
  } finally {
    // Restore original read-only state
    await updateState({ editorReadOnly: originalReadOnly })
  }
  // manually pressing the sync button should reload file data even if there were no changes
  await fileselection.reload({refresh:true})
}