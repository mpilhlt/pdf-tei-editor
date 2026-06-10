/**
 * LayoutPlugin — persists global layout UI state.
 *
 * Owns UI elements in index.html that are not managed by any other plugin.
 * Currently persists: split panel divider position.
 *
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 */

import { Plugin } from '../modules/plugin-base.js';

class LayoutPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'layout' });
  }

  /**
   * @param {ApplicationState} initialState
   */
  async install(initialState) {
    await super.install(initialState);
    const panel = document.querySelector('#editors');
    if (panel) {
      this.uiStorage.bind(panel, 'position', {
        key: 'splitPosition',
        event: 'sl-reposition',
        default: 50,
      });
    }
  }
}

export default LayoutPlugin;
