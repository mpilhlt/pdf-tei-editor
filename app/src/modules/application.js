/**
 * Application class - clean wrapper around plugin endpoint invocation and bootstrapping
 * @import { ApplicationState } from '../state.js'
 * @import PluginManager from '../modules/plugin-manager.js'
 * @import StateManager from '../modules/state-manager.js'
 * @import { InvokeOptions, InvocationResult } from '../modules/plugin-manager.js'
 */

import { PluginContext } from './plugin-context.js';
import ep from '../extension-points.js';

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

  /**
   * State changes explicitly scheduled via scheduleStateChange() to run after the
   * current propagation cycle completes. Each entry is { changes, resolve, reject }.
   * @type {Array<{changes: Partial<ApplicationState>, resolve: (s: ApplicationState)=>void, reject: (e: Error)=>void}>}
   */
  #scheduledStateChanges = [];

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
    // Prevent accidental re-entrant state changes during plugin notification.
    // If you need to dispatch after async work triggered by onStateUpdate, use scheduleStateChange().
    if (this.#isUpdatingState) {
      throw new Error('State changes are not allowed during state update propagation. Plugin state.update endpoints must be reactive observers only, not state mutators. Use scheduleStateChange() to dispatch after async work.');
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
      
      // 3. New system: onStateUpdate with changed keys (catch-all)
      const changeResults = await this.#pluginManager.invoke(ep.state.onStateUpdate, [changedKeys, newState], { result: 'full' });
      this.#checkForStateChangeErrors(changeResults);

      // 4. Per-key dispatch: state.<key>(newVal, prevVal, state) for object plugins
      //    and onStateUpdate.<key>(newVal, prevVal) for class plugins (on<Key>Change methods)
      for (const key of changedKeys) {
        const newVal = newState[key];
        const prevVal = this.#stateManager.getPreviousStateValue(newState, key);
        const perKeyArgs = [newVal, prevVal, newState];
        const perKeyResults1 = await this.#pluginManager.invoke(`state.${key}`, perKeyArgs, { mode: 'sequential', result: 'full' });
        this.#checkForStateChangeErrors(perKeyResults1);
        const perKeyResults2 = await this.#pluginManager.invoke(`onStateUpdate.${key}`, [newVal, prevVal], { mode: 'sequential', result: 'full' });
        this.#checkForStateChangeErrors(perKeyResults2);
      }

      // Update current state after successful plugin notification
      this.#currentState = newState;
      
      return newState;
    } finally {
      this.#isUpdatingState = false;
      this.#flushScheduledStateChanges();
    }
  }

  /**
   * Schedule a state change to run after the current propagation cycle completes.
   *
   * Use this only when a plugin needs to dispatch state changes as a result of async
   * work that was triggered by onStateUpdate (e.g. an API call whose result affects
   * state). Do NOT use it to work around the observer-only rule for synchronous work —
   * synchronous onStateUpdate handlers must remain pure observers.
   *
   * @param {Partial<ApplicationState>} changes
   * @returns {Promise<ApplicationState>}
   */
  scheduleStateChange(changes) {
    if (!this.#isUpdatingState) {
      return this.updateState(changes);
    }
    return new Promise((resolve, reject) => {
      this.#scheduledStateChanges.push({ changes, resolve, reject });
    });
  }

  /**
   * Flush state changes that were explicitly scheduled via scheduleStateChange().
   * Merges all pending changes into one update to avoid chained re-renders.
   */
  #flushScheduledStateChanges() {
    if (this.#scheduledStateChanges.length === 0) return;
    const pending = this.#scheduledStateChanges.splice(0);
    const merged = Object.assign({}, ...pending.map(p => p.changes));
    this.updateState(merged)
      .then(state => pending.forEach(p => p.resolve(state)))
      .catch(err => pending.forEach(p => p.reject(err)));
  }

  /**
   * Update extension properties in state and notify plugins
   * @param {Object} extChanges - Extension properties to update
   * @returns {Promise<ApplicationState>} New state after plugin notification
   */
  async updateStateExt(extChanges = {}) {
    if (this.#isUpdatingState) {
      throw new Error('State changes are not allowed during state update propagation. Use scheduleStateChange() to dispatch after async work.');
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
        this.#flushScheduledStateChanges();
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
      this.#flushScheduledStateChanges();
    }
  }

  /**
   * Check plugin invocation results for errors and rethrow them.
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

  /**
   * Get the public API of a registered plugin by name.
   * For class-based plugins returns the Plugin instance; for object plugins returns the
   * `api` field (or the plugin descriptor as fallback).
   * @param {string} name - Plugin name
   * @returns {any} The plugin's public API
   */
  getDependency(name) {
    return this.#pluginManager.getDependency(name);
  }
}

export default Application;