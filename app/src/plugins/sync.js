/**
 * This plugin provides file synchronization functionality with WebDAV servers
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlButton } from '../ui.js'
 */
import ui, { updateUi } from '../ui.js'
import {
  updateState, client, logger, fileselection, xmlEditor, sse
} from '../app.js'
import { createHtmlElements } from '../ui.js'
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

//
// UI
//

/**
 * Sync button group navigation properties
 * @typedef {object} syncActionsPart
 * @property {SlButton} sync - Sync files button
 */

const syncActionButtons = await createHtmlElements("sync-action-buttons.html")

// Sync progress widget for XML editor statusbar
let syncProgressWidget = null

//
// Implementation
//

/**
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)

  // install controls on menubar
  ui.toolbar.append(...syncActionButtons)
  updateUi()

  const sa = ui.toolbar.syncActions

  // sync
  sa.sync.addEventListener("click", () => onClickSyncBtn(state))

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
    console.log(`Sync: ${message}`)
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
  const syncIcon = document.createElement('sl-icon')
  syncIcon.name = 'arrow-repeat'
  syncIcon.style.marginRight = '4px'
  syncIcon.style.cursor = 'pointer'
  syncIcon.title = 'Click to sync files'
  
  // Add click handler to sync icon to start sync
  syncIcon.addEventListener('click', () => onClickSyncBtn(state))
  
  // Create a container that includes the icon and progress bar
  const syncContainer = document.createElement('div')
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
  const sa = ui.toolbar.syncActions

  sa.childNodes.forEach(el => {
    if ('disabled' in el) {
      el.disabled = state.offline}
    }
  )
  if (state.offline) {
    return
  }

  // disable sync if webdav is not enabled
  sa.sync.disabled = !state.webdavEnabled
}

/**
 * Synchronizes the files on the server with the WebDAV backend, if so configured
 * @param {ApplicationState} state 
 */
async function syncFiles(state) {
  if (state.webdavEnabled) {
    logger.debug("Synchronizing files on the server")
    const summary = await client.syncFiles()
    
    if (summary.skipped) {
      logger.debug("Sync skipped - no changes detected")
    } else {
      logger.debug("Sync completed", summary)
    }
    
    return summary
  }
  return false
}

/**
 * Event handler for sync button click
 * @param {ApplicationState} state
 */
async function onClickSyncBtn(state) {
  let summary
  
  // Store original read-only state to restore later
  const originalReadOnly = state.editorReadOnly
  
  // Set editor to read-only during sync to prevent conflicts
  updateState(state, { editorReadOnly: true })
  
  // Reset progress widget for new sync
  if (syncProgressWidget) {
    syncProgressWidget.indeterminate = true
    syncProgressWidget.value = 0
  }
  
  try {
    summary = await syncFiles(state)
  } catch (e) {
    throw e
  } finally {
    // Reset progress widget to 0% after sync completion
    if (syncProgressWidget) {
      syncProgressWidget.indeterminate = false
      syncProgressWidget.value = 0
    }
    
    // Restore original read-only state
    updateState(state, { editorReadOnly: originalReadOnly })
  }
  if (summary) {
    if (!summary.skipped) {
      // Check if any changes were made and reload file data if needed
      const hasChanges = Object.entries(summary).some(([action, count]) => 
        count > 0 && action !== 'skipped' && action !== 'stale_locks_purged'
      )
      
      if (hasChanges) {
        // something has changed, reload the file data
        await fileselection.reload(state)
      }
    }
  }
}