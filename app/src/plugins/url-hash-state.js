/**
 * This component sets all string properties of the application state as hash parameters of the URL
 * This might have to be changed later in case we do not want to show all string properties in the app state
 */

import { logger, config, updateState } from '../app.js'
import { UrlHash } from '../modules/browser-utils.js'

/** 
 * @import { ApplicationState } from '../app.js' 
 */

// module closure vars
let showInUrl
let allowSetFromUrl

const api = {
  updateUrlHashfromState,
  updateStateFromUrlHash
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
 * Updates the state from the URL hash, removing all state properties that should not be shown in the URL from the hash
 * @param {ApplicationState} state
 * @returns {Promise<Array>} Returns the result of updateState
 */
async function updateStateFromUrlHash(state) {
  const tmpState = {}
  const urlParams = new URLSearchParams(window.location.hash.slice(1));
  for (const [key, value] of urlParams.entries()) {
    if (key in state && allowSetFromUrl.includes(key)) {
      tmpState[key] = value
    }
    if (!showInUrl.includes(key)) {
      UrlHash.remove(key, false)
    }
  }
  logger.info("Setting state properties from URL hash:" + Object.keys(tmpState).join(", "))
  return await updateState(state, tmpState)
}