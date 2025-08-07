/**
 * This component sets all string properties of the application state as hash parameters of the URL
 * This might have to be changed later in case we do not want to show all string properties in the app state
 */

import { logger } from '../app.js'

/** 
 * @import { ApplicationState } from '../app.js' 
 */

// this needs to be made configurable
const allowedUrlHashParams = ['pdfPath','xmlPath', 'diffXmlPath', 'xpath', 'sessionId', 'variant']

const api = {
  updateUrlHashfromState,
  updateStateFromUrlHash
}

/**
 * component plugin
 */
const plugin = {
  name: "url-hash-state",
  install,
  state: {
    update
  }
}

export {plugin, api}
export default plugin

//
// implementation
//

/** 
 * @param {ApplicationState} state 
 */
async function install(state){
  logger.debug(`Installing plugin "${plugin.name}"`)
}

/** 
 * @param {ApplicationState} state 
 */
async function update(state) {
  updateUrlHashfromState(state)
  //console.warn(plugin.name,"done")
  //console.warn(plugin.name,"done")
}

/**
 * @param {ApplicationState} state 
 */
function updateUrlHashfromState(state) {
  const url = new URL(window.location.href);
  const urlHashParams = new URLSearchParams(window.location.hash.slice(1));
  Object.entries(state)
    .filter(([key]) => allowedUrlHashParams.includes(key))
    .forEach(([key, value]) => {
      if (value) {
        urlHashParams.set(key, String(value))
      } else {
        urlHashParams.delete(key)
      }
    })
  let hash = `#${urlHashParams.toString()}`;
  if (hash !== url.hash) {
    //logger.debug(`url hash changed to ${hash}`)
    url.hash = hash
    //window.history.replaceState({}, '', url);
    window.history.pushState({}, '', url);
  }
}


/**
 * Updates the state from the URL hash.
 * @param {ApplicationState} state
 */
function updateStateFromUrlHash(state) {
  const urlParams = new URLSearchParams(window.location.hash.slice(1));
  for (const [key, value] of urlParams.entries()) {
    if (key in state && allowedUrlHashParams.includes(key)) {
      state[key] = value
    }
  }
} 