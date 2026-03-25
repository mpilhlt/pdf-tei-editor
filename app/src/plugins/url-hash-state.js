/**
 * Plugin that saves selected application state properties in the URL hash
 * and restores them on page load.
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 */

import { Plugin } from '../modules/plugin-base.js'
import { UrlHash } from '../modules/browser-utils.js'

class UrlHashStatePlugin extends Plugin {
  /** @type {string[]} */
  #showInUrl = []

  /** @type {string[]} */
  #allowSetFromUrl = []

  /**
   * @param {PluginContext} context
   */
  constructor(context) {
    super(context, { name: 'url-hash-state', deps: ['config'] })
  }

  /**
   * @param {ApplicationState} state
   */
  async install(state) {
    await super.install(state)
    const config = this.getDependency('config')
    this.#showInUrl = await config.get('state.showInUrl') || []
    this.#allowSetFromUrl = await config.get('state.allowSetFromUrl') || []
  }

  async onStateUpdate(changedKeys) {
    this.updateUrlHashfromState()
  }

  /**
   * Updates the URL hash from the current application state.
   */
  updateUrlHashfromState() {
    const url = new URL(window.location.href)
    const urlHashParams = new URLSearchParams(window.location.hash.slice(1))
    Object.entries(this.state)
      .filter(([key]) => this.#showInUrl.includes(key))
      .forEach(([key, value]) => {
        if (value) {
          urlHashParams.set(key, String(value))
        } else {
          urlHashParams.delete(key)
        }
      })
    const hash = `#${urlHashParams.toString()}`
    if (hash !== url.hash) {
      url.hash = hash
      window.history.replaceState({}, '', url)
    }
  }

  /**
   * Gets state properties from the URL hash without updating state.
   * @returns {Partial<ApplicationState>}
   */
  getStateFromUrlHash() {
    /** @type {Record<string, string>} */
    const tmpState = {}
    const urlParams = new URLSearchParams(window.location.hash.slice(1))
    for (const [key, value] of urlParams.entries()) {
      if (this.#allowSetFromUrl.includes(key)) {
        tmpState[key] = value
      }
      if (!this.#showInUrl.includes(key)) {
        UrlHash.remove(key, false)
      }
    }
    if (Object.keys(tmpState).length > 0) {
      this.getDependency('logger').info('Getting state properties from URL hash: ' + Object.keys(tmpState).join(', '))
    }
    return tmpState
  }

  /**
   * Updates application state from the URL hash.
   * @returns {Promise<ApplicationState>}
   */
  async updateStateFromUrlHash() {
    const tmpState = this.getStateFromUrlHash()
    return await this.dispatchStateChange(tmpState)
  }
}

export default UrlHashStatePlugin
