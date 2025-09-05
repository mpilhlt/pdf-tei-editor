/**
 * Application class - clean wrapper around plugin endpoint invocation and bootstrapping
 * @import { ApplicationState } from '../app.js'
 * @import PluginManager from '../modules/plugin-manager.js'
 * @import StateManager from '../modules/state-manager.js'
 */

import { PluginContext } from './plugin-context.js';
import ep from '../endpoints.js';

/**
 * Application class that provides a clean API for plugin management and bootstrapping
 */
export class Application {
  /**
   * @param {PluginManager} pluginManager 
   * @param {StateManager} stateManager 
   */
  constructor(pluginManager, stateManager) {
    this.#currentState = null;
    this.#pluginManager = pluginManager;
    this.#stateManager = stateManager;
    this.#pluginContext = new PluginContext(this);
    
    // Set up shutdown handler
    window.addEventListener('beforeunload', () => {
      this.shutdown();
    });
  }

  /** 
   * simple flag for controlling debug messages
   */
  debug = false;

  /** @type {ApplicationState|null} */
  #currentState;

  /** @type {PluginManager} */
  #pluginManager;

  /** @type {StateManager} */
  #stateManager;

  /** @type {PluginContext} */
  #pluginContext;

  //
  // Application bootstrapping methods
  //

  /**
   * Initialize application state with final composed state and configure bootstrapping
   * @param {ApplicationState} finalState - The final composed initial state
   * @param {object} options - Configuration options
   * @param {string[]} [options.persistedStateVars] - State variable names to persist in sessionStorage
   * @param {boolean} [options.enableStatePreservation=true] - Whether to enable automatic state preservation
   * @returns {ApplicationState} The initialized state
   */
  initializeState(finalState, options = {}) {
    const {
      persistedStateVars = [],
      enableStatePreservation = true
    } = options;

    // Update current state
    this.#currentState = finalState;

    // Enable automatic state preservation if requested
    if (enableStatePreservation) {
      // Always include sessionId in persisted vars
      const allPersistedVars = [...persistedStateVars, 'sessionId'];
      this.#stateManager.preserveState(true, allPersistedVars);
    }

    return this.#currentState;
  }

  /**
   * Get the current state
   * @returns {ApplicationState|null}
   */
  getCurrentState() {
    return this.#currentState;
  }

  //
  // Plugin lifecycle management
  //

  /**
   * Register plugins with the plugin manager
   * Supports plugin objects, Plugin class instances, and Plugin classes.
   * @param {Array} plugins - Array of plugin objects, Plugin instances, or Plugin classes
   */
  registerPlugins(plugins) {
    // Convert classes to instances, leave everything else as-is
    const processedPlugins = plugins.map(plugin => {
      // Check if it's a Plugin class (constructor function)
      if (typeof plugin === 'function' && plugin.prototype && plugin.prototype.constructor === plugin) {
        this.debug && console.log(`Creating Plugin singleton instance from class '${plugin.name}' with context`);
        return plugin.createInstance(this.#pluginContext);
      }
      return plugin;
    });

    // Register plugins - PluginManager handles Plugin instance conversion
    for (const plugin of processedPlugins) {
      const pluginName = plugin.name || plugin.constructor?.name || 'unknown';
      const deps = plugin.deps || [];
      this.debug && console.log(`Registering plugin '${pluginName}' with deps: [${deps.join(', ') || 'none'}]`);
      this.#pluginManager.register(plugin);
    }
  }

  /**
   * Install all registered plugins with provided state
   * @param {ApplicationState} state - The state to pass to plugin install methods
   * @returns {Promise<Array>}
   */
  async installPlugins(state) {
    const results = await this.#pluginManager.invoke(ep.install, state, { mode: 'sequential' });
    return results;
  }

  /**
   * Start all plugins after installation
   * @returns {Promise<Array>}
   */
  async start() {
    const results = await this.#pluginManager.invoke(ep.start, [], { mode: 'sequential' });
    return results;
  }

  /**
   * Shutdown all plugins (called on beforeunload)
   * @returns {Promise<Array>}
   */
  async shutdown() {
    try {
      const results = await this.#pluginManager.invoke(ep.shutdown, [], { mode: 'sequential' });
      return results;
    } catch (error) {
      console.warn('Error during plugin shutdown:', error);
      return [];
    }
  }

  //
  // State management orchestration
  //

  /**
   * Update application state and notify plugins
   * @param {ApplicationState} currentState - Current state
   * @param {Partial<ApplicationState>} changes - Changes to apply
   * @returns {Promise<ApplicationState>} New state after plugin notification
   */
  async updateState(currentState, changes = {}) {
    const { newState, changedKeys } = this.#stateManager.applyStateChanges(currentState, changes);
    
    // Skip plugin notification if no actual changes
    if (changedKeys.length === 0) {
      await this.#pluginManager.invoke(ep.state.update, currentState);
      return currentState;
    }
    
    // Invoke all state update endpoints by convention:
    
    // 1. Legacy system: state.update with full state
    await this.#pluginManager.invoke(ep.state.update, newState);
    
    // 2. New system: updateInternalState with full state (silent)
    await this.#pluginManager.invoke(ep.state.updateInternal, newState);
    
    // 3. New system: onStateUpdate with changed keys
    await this.#pluginManager.invoke(ep.state.onChange, changedKeys);
    
    return newState;
  }

  /**
   * Update extension properties in state and notify plugins
   * @param {ApplicationState} currentState - Current state
   * @param {Object} extChanges - Extension properties to update
   * @returns {Promise<ApplicationState>} New state after plugin notification
   */
  async updateStateExt(currentState, extChanges = {}) {
    const { newState, changedKeys } = this.#stateManager.applyExtensionChanges(currentState, extChanges);
    
    if (changedKeys.length === 0) {
      await this.#pluginManager.invoke(ep.state.update, currentState);
      return currentState;
    }
    
    await this.#pluginManager.invoke(ep.state.update, newState);
    return newState;
  }

  /**
   * Get state manager for direct access to state utilities
   * @returns {StateManager}
   */
  getStateManager() {
    return this.#stateManager;
  }

  /**
   * Get plugin context for plugin instantiation
   * @returns {PluginContext}
   */
  getPluginContext() {
    return this.#pluginContext;
  }

  //
  // Convenience methods for common plugin operations
  //

  /**
   * Invoke any plugin endpoint
   * @param {string} endpoint
   * @param {...*} args - Arguments to pass to the endpoint functions
   * @returns {Promise<Array>}
   */
  async invokePluginEndpoint(endpoint, ...args) {
    return await this.#pluginManager.invoke(endpoint, ...args);
  }

}

export default Application;