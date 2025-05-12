/**
 * This component provides a simple logging component which can be extended later
 * or replaced with a shim to an external library
 */

// name of the plugin
const name = "url-hash-state"

/**
 * component plugin
 */
const plugin = {
  name,
  state: {
    update: updateUrlHashfromState
  }
}

//
// exports 
//
export {plugin}
export default plugin

//
// implementation
//

/**
 * 
 * @param {import("../app").ApplicationState} state 
 */
export function updateUrlHashfromState(state) {
  const url = new URL(window.location.href);
  const urlHashParams = new URLSearchParams(window.location.hash.slice(1));
  Object.entries(state)
    .filter(([, value]) => typeof value === "string")
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
 */
export function updateStateFromUrlHash(state) {
  const urlParams = new URLSearchParams(window.location.hash.slice(1));
  for (const [key, value] of urlParams.entries()) {
    if (key in state) {
      state.key = value
    }
  }
} 