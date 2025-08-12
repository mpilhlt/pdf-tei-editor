/**
 * This plugin provides file synchronization functionality with WebDAV servers
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlButton } from '../ui.js'
 */
import ui, { updateUi } from '../ui.js'
import {
  updateState, client, logger, fileselection, services, sse
} from '../app.js'
import { createHtmlElements } from '../ui.js'
import { notify } from '../modules/sl-utils.js'

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
    console.log(`Sync progress: ${progress}%`)
  })

  sse.addEventListener('syncMessage', (event) => {
    const message = event.data
    console.log(`Sync: ${message}`)
  })
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
  ui.spinner.show('Synchronizing files, please wait...')
  try {
    summary = await syncFiles(state)
  } catch (e) {
    throw e
  } finally {
    ui.spinner.hide()
  }
  if (summary) {
    if (summary.skipped) {
      notify("Sync skipped - no changes detected")
    } else {
      let msg = []
      for (const [action, count] of Object.entries(summary)) {
        if (count > 0 && action !== 'skipped') {
          msg.push(`${action.replace('_', ' ')}: ${count}`)
        }
      }
      if (msg.length > 0) {
        notify(msg.join(", "))
        // something has changed, reload the file data
        await fileselection.reload(state)
      } else {
        notify("Sync completed - no changes needed")
      }
    }
  }
}