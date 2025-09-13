/**
 * This plugin provides an API to save selected properties of the application state in the URL hash
 * and to update the application state from the URL hash on page load.
 * This allows sharing links to the current application state and restoring the state when reloading the page
 */

import { logger, config, updateState } from '../app.js'
import { UrlHash } from '../modules/browser-utils.js'

/** 
 * @import { ApplicationState } from '../state.js' 
 */

// module closure vars
let showInUrl
let allowSetFromUrl

const api = {
  updateUrlHashfromState,
  updateStateFromUrlHash,
  getStateFromUrlHash
}

/**
 * component plugin
 */
const plugin = {
  name: "url-hash-state",
  deps: ['config'],
  install,
  state: {
    update
  }
}

export { plugin, api }
export default plugin

//
// implementation
//

/** 
 * @param {ApplicationState} state 
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`)
  showInUrl = await config.get("state.showInUrl") || []
  allowSetFromUrl = await config.get("state.allowSetFromUrl") || []
}

/** 
 * @param {ApplicationState} state 
 */
async function update(state) {
  updateUrlHashfromState(state)
}

/**
 * @param {ApplicationState} state 
 */
function updateUrlHashfromState(state) {
  const url = new URL(window.location.href);
  const urlHashParams = new URLSearchParams(window.location.hash.slice(1));
  Object.entries(state)
    .filter(([key]) => showInUrl.includes(key))
    .forEach(([key, value]) => {
      if (value) {
        urlHashParams.set(key, String(value))
      } else {
        urlHashParams.delete(key)
      }
    })
  let hash = `#${urlHashParams.toString()}`;
  if (hash !== url.hash) {
    url.hash = hash
    window.history.replaceState({}, '', url);
  }
}

/**
 * Gets state properties from URL hash without updating state (for initialization)
 * @returns {Object} Object with state properties from URL hash
 */
function getStateFromUrlHash() {
  const tmpState = {}
  const urlParams = new URLSearchParams(window.location.hash.slice(1));
  for (const [key, value] of urlParams.entries()) {
    if (allowSetFromUrl.includes(key)) {
      tmpState[key] = value
    }
    if (!showInUrl.includes(key)) {
      UrlHash.remove(key, false)
    }
  }
  if (Object.keys(tmpState).length > 0) {
    logger.info("Getting state properties from URL hash: " + Object.keys(tmpState).join(", "))
  }
  return tmpState
}

/**
 * Updates the state from the URL hash, removing all state properties that should not be shown in the URL from the hash
 * @param {ApplicationState} state
 * @returns {Promise<Array>} Returns the result of updateState
 */
async function updateStateFromUrlHash(state) {
  const tmpState = getStateFromUrlHash()
  return await updateState(tmpState)
}