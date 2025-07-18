/**
 * This component sets all string properties of the application state as hash parameters of the URL
 * This might have to be changed later in case we do not want to show all string properties in the app state
 */

import { logger } from '../app.js'

/** 
 * @import { ApplicationState } from '../app.js' 
 */

// this needs to be made configurable
const allowedUrlHashParams = ['pdfPath','xmlPath', 'diffXmlPath', 'xpath']

const api = {
  updateState: updateStateFromUrlHash
}

/**
 * component plugin
 */
const plugin = {
  name: "url-hash-state",
  install,
  state: {
    update: updateUrlHashfromState
  }
}

export {plugin, api}
export default plugin

//
// implementation
//

async function install(state){
  logger.debug(`Installing plugin "${plugin.name}"`)
}

/**
 * 
 * @param {ApplicationState} state 
 */
export function updateUrlHashfromState(state) {
  const url = new URL(window.location.href);
  const urlHashParams = new URLSearchParams(window.location.hash.slice(1));
  Object.entries(state)
    .filter(([key]) => allowedUrlHashParams.includes(key))
    .forEach(([key, value]) => {
      if (value) {
        urlHashParams.set(key, value)
      } else {
        urlHashParams.delete(key)
      }
    })
  url.hash = `#${urlHashParams.toString()}`;
  //window.history.replaceState({}, '', url);
  window.history.pushState({}, '', url);
}


/**
 * Updates the state from the URL hash.
 * @param {ApplicationState} state
 */
function updateStateFromUrlHash(state) {
  const urlParams = new URLSearchParams(window.location.hash.slice(1));
  for (const [key, value] of urlParams.entries()) {
    if (key in state) {
      state[key] = value
    }
  }
} 