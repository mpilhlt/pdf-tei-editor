/**
 * Application class - clean wrapper around plugin endpoint invocation and bootstrapping
 * @import { ApplicationState } from '../state.js'
 * @import PluginManager from '../modules/plugin-manager.js'
 * @import StateManager from '../modules/state-manager.js'
 * @import { InvokeOptions, InvocationResult } from '../modules/plugin-manager.js'
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
      this.shutdown().catch(() => {});
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

  /** @type {boolean} */
  #isUpdatingState = false;

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
   * @returns {ApplicationState}
   */
  getCurrentState() {
    if (!this.#currentState) {
      throw new Error("State has not been initialized yet")
    }
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
    const results = await this.#pluginManager.invoke(ep.install, state, { mode: 'sequential', result: 'full' });
    return results;
  }

  /**
   * Start all plugins after installation
   * @returns {Promise<Array>}
   */
  async start() {
    const results = await this.#pluginManager.invoke(ep.start, [], { mode: 'sequential', result: 'full' });
    return results;
  }

  /**
   * Shutdown all plugins (called on beforeunload)
   * @returns {Promise<Array>}
   */
  async shutdown() {
    try {
      const results = await this.#pluginManager.invoke(ep.shutdown, [], { mode: 'sequential', result: 'full' });
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
   * @param {Partial<ApplicationState>} changes - Changes to apply  
   * @returns {Promise<ApplicationState>} New state after plugin notification
   */
  async updateState(changes = {}) {
    // Prevent nested state changes during plugin notification
    if (this.#isUpdatingState) {
      throw new Error('State changes are not allowed during state update propagation. Plugin state.update endpoints must be reactive observers only, not state mutators.');
    }

    // Use current state as base for changes
    const currentState = this.#currentState;
    if (!currentState) {
      throw new Error('Application state not initialized. Call initializeState() first.');
    }

    const { newState, changedKeys } = this.#stateManager.applyStateChanges(currentState, changes);
    
    // Skip plugin notification if no actual changes (only legacy system)
    if (changedKeys.length === 0) {
      this.#isUpdatingState = true;
      try {
        const results = await this.#pluginManager.invoke(ep.state.update, currentState, { result: 'full' });
        this.#checkForStateChangeErrors(results);
      } finally {
        this.#isUpdatingState = false;
      }
      return currentState;
    }
    
    // Set lock to prevent nested state changes
    this.#isUpdatingState = true;
    
    try {
      // Invoke all state update endpoints by convention:
      
      // 1. Legacy system: state.update with full state
      const legacyResults = await this.#pluginManager.invoke(ep.state.update, newState, { result: 'full' });
      this.#checkForStateChangeErrors(legacyResults);
      
      // 2. New system: updateInternalState with full state (silent)
      const internalResults = await this.#pluginManager.invoke(ep.state.updateInternal, newState, { result: 'full' });
      this.#checkForStateChangeErrors(internalResults);
      
      // 3. New system: onStateUpdate with changed keys
      const changeResults = await this.#pluginManager.invoke(ep.state.onStateUpdate, [changedKeys, newState], { result: 'full' });
      this.#checkForStateChangeErrors(changeResults);
      
      // Update current state after successful plugin notification
      this.#currentState = newState;
      
      return newState;
    } finally {
      // Always release the lock
      this.#isUpdatingState = false;
    }
  }

  /**
   * Update extension properties in state and notify plugins
   * @param {Object} extChanges - Extension properties to update
   * @returns {Promise<ApplicationState>} New state after plugin notification
   */
  async updateStateExt(extChanges = {}) {
    // Prevent nested state changes during plugin notification
    if (this.#isUpdatingState) {
      throw new Error('State changes are not allowed during state update propagation. Plugin state.update endpoints must be reactive observers only, not state mutators.');
    }

    // Use current state as base for changes
    const currentState = this.#currentState;
    if (!currentState) {
      throw new Error('Application state not initialized. Call initializeState() first.');
    }

    const { newState, changedKeys } = this.#stateManager.applyExtensionChanges(currentState, extChanges);
    
    if (changedKeys.length === 0) {
      this.#isUpdatingState = true;
      try {
        const results = await this.#pluginManager.invoke(ep.state.update, currentState, { result: 'full' });
        this.#checkForStateChangeErrors(results);
      } finally {
        this.#isUpdatingState = false;
      }
      return currentState;
    }
    
    this.#isUpdatingState = true;
    try {
      const results = await this.#pluginManager.invoke(ep.state.update, newState, { result: 'full' });
      this.#checkForStateChangeErrors(results);
      
      // Update current state after successful plugin notification
      this.#currentState = newState;
      
      return newState;
    } finally {
      this.#isUpdatingState = false;
    }
  }

  /**
   * Check plugin invocation results for state change errors and rethrow them
   * @param {Array} results - Results from plugin manager invoke
   */
  #checkForStateChangeErrors(results) {
    for (const result of results) {
      if (result.status === 'rejected' && result.reason?.message?.includes('State changes are not allowed during state update propagation')) {
        throw result.reason;
      }
    }
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
   * Invoke an endpoint on all plugins that implement it, in dependency order.
   * By default, throws on the first error encountered, and returns the value of the 
   * first fulfilled promise (or synchronous function). For other options, see {InvokeOptions}
   * 
   * @param {string} endpoint - Endpoint to invoke
   * @param {*|Array} [args] - Arguments to pass to endpoint functions. If array, spread as parameters; if not array, pass as single parameter
   * @param {InvokeOptions} [options] - Optional configuration for this invocation. 
   * @returns {Promise<InvocationResult[] | any[] | any>} Result formatted depending on options.result
   */
  async invokePluginEndpoint(endpoint, args = [], options = {throws:true, result:'first'}) {
    const result = await this.#pluginManager.invoke(endpoint, args, options);
    return result
  }

  /**
   * Get the plugin manager for direct access (use with caution)
   * @returns {PluginManager}
   */
  getPluginManager() {
    return this.#pluginManager;
  }
}

export default Application;