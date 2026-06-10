/**
 * Plugin providing an application configuration API.
 * Config is stored on the server and changes only when explicit, relatively permanent
 * changes to the application's behavior are intended.
 */

/** @import { PluginContext } from '../modules/plugin-context.js' */

import Plugin from '../modules/plugin-base.js';

class ConfigPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, {
      name: 'config',
      deps: ['client']
    });
    /** @type {Object<string, any>|undefined} */
    this._configMap = undefined;
  }

  /**
   * Fetches the configuration data from the server and updates the local map.
   * @returns {Promise<void>}
   */
  async load() {
    this.getDependency('logger').debug('Updating configuration data.');
    this._configMap = await this.getDependency('client').getConfigData();
  }

  /**
   * Returns all configuration as a Map.
   * @returns {Map<string, any>}
   */
  toMap() {
    return new Map(Object.entries(this._configMap));
  }

  /**
   * Retrieves a configuration value for a given key.
   * @param {string} key
   * @param {any} [defaultValue] Returned if key does not exist (instead of throwing)
   * @param {boolean} [updateFirst=false] If true, forces a server refresh first
   * @returns {Promise<any>}
   */
  async get(key, defaultValue, updateFirst = false) {
    if (!this._configMap || updateFirst) {
      await this.load();
    }
    if (this._configMap === undefined) {
      throw new Error('Configuration data has not been loaded yet');
    }
    if (key in this._configMap) {
      return this._configMap[key];
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new TypeError(`No configuration key "${key}" exists`);
  }

  /**
   * Called when the active project changes.
   * Reloads configuration with project-specific overrides applied.
   * @param {string|null} newProject
   * @returns {Promise<void>}
   */
  async onProjectChange(newProject) {
    this.getDependency('logger').debug(`Reloading config for project: ${newProject}`);
    try {
      const response = await this.getDependency('client').getConfigData(newProject || null);
      this._configMap = response || {};
    } catch (error) {
      this.getDependency('logger').error('Failed to reload config for project:', String(error));
    }
  }

  /**
   * Sets a configuration value for a given key on the server.
   * @param {string} key
   * @param {any} value
   * @returns {Promise<void>}
   */
  async set(key, value) {
    // Verify key exists first
    await this.get(key);
    await this.getDependency('client').setConfigValue(key, value);
  }
}

export default ConfigPlugin;


/** @deprecated Use ConfigPlugin class directly */
export const plugin = ConfigPlugin;
