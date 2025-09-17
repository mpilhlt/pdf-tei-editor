/**
 * Plugin providing an application configuration related API
 * The configuration is different from the application's state as it is stored on the server and typically 
 * changes only if explicit and relatively permanent changes to the application's behavior are intended.
 * It exposes only a public API and has no install or update lifecycle hooks 
 */

/** 
 * @import { PluginConfig } from '../modules/plugin-manager.js'
 */

import { logger, client } from '../app.js';

/**
 * The public API of the config plugin.
 * @namespace
 */
const api = {
  get,
  set,
  load: updateConfigData
}

/**
 * The configuration plugin definition.
 * @type {PluginConfig}
 */
const plugin = {
  name: "config",
  deps: ['client']
}

export { api, plugin }
export default plugin

/**
 * A Map-like object holding the configuration data fetched from the server.
 * @type {Object<string, any> | undefined}
 */
let configMap;

/**
 * Fetches the configuration data from the server and updates the local `configMap`.
 * @async
 * @returns {Promise<void>} A promise that resolves when the configuration is updated.
 */
async function updateConfigData () {
  logger.debug('Updating configuration data.')
  configMap = await client.getConfigData()
}

/**
 * Checks if a given key exists in the configuration data and returns it value. If the key does not exist,
 * it either returns a default value if one has been passed, or throws a type error
 * @param {string} key The configuration key to check.
 * @param {string} [defaultValue] The value to return if the key does not exist
 * @throws {TypeError} If the key does not exist in the configuration and no default value hass been passed
 */
async function _get(key, defaultValue){
  if (configMap === undefined) {
    throw new Error("Configuration data has not been loaded yet")
  }
  if (key in configMap) {
    return configMap[key]
  } 
  if (defaultValue !== undefined) {
    return defaultValue
  }
  throw new TypeError(`No configuration key "${key}" exists`)
}

/**
 * Retrieves a configuration value for a given key.
 * @async
 * @param {string} key The key of the configuration value to retrieve.
 * @param {any} [defaultValue] The value to return if the key does not exist
 * @param {boolean} [updateFirst=false] - If true, forces an update from the server before getting the value.
 * @returns {Promise<any>} A promise that resolves with the configuration value.
 * @throws {TypeError} If the key does not exist.
 */
async function get(key, defaultValue, updateFirst=false) {
  if (!configMap || updateFirst) {
    await updateConfigData()
  }
  return await _get(key, defaultValue)
}

/**
 * Sets a configuration value for a given key on the server.
 * @async
 * @param {string} key The key of the configuration value to set.
 * @param {any} value The new value to set.
 * @returns {Promise<void>} A promise that resolves when the value has been set.
 * @throws {TypeError} If the key does not exist.
 */
async function set(key, value) {
  await _get(key) // this checks the key 
  await client.setConfigValue(key, value)
}