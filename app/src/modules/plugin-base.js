/**
 * Base Plugin class for class-based plugin architecture
 * @import { ApplicationState } from '../app.js'
 * @import { PluginContext } from './plugin-context.js'
 */

/**
 * Base class for plugins that provides state management and lifecycle methods
 */
export class Plugin {
  /**
   * @param {PluginContext} context - Plugin context providing controlled access to application services
   * @param {object} [config] - Plugin configuration
   * @param {string} [config.name] - Plugin name
   * @param {string[]} [config.deps] - Plugin dependencies
   */
  constructor(context, config = {}) {
    if (!context) {
      throw new Error('PluginContext is required for Plugin constructor');
    }
    this.context = context;
    this.name = config.name || this.constructor.name.toLowerCase();
    this.deps = config.deps || [];
    this.#state = null;
  }

  /** @type {Map<Function, Plugin>} */
  static instances = new Map();

  /**
   * Create singleton instance of this plugin class
   * @param {PluginContext} context - Plugin context
   * @returns {Plugin} The singleton instance
   */
  static createInstance(context) {
    if (!Plugin.instances.has(this)) {
      Plugin.instances.set(this, new this(context));
    }
    return Plugin.instances.get(this) || new this(context);
  }

  /**
   * Get singleton instance of this plugin class
   * @returns {Plugin|null} The singleton instance or null if not created yet
   */
  static getInstance() {
    return Plugin.instances.get(this) || null;
  }

  /** @type {ApplicationState|null} */
  #state = null;

  //
  // Plugin lifecycle methods (override in subclasses)
  //

  /**
   * Plugin installation - override in subclasses
   * @param {ApplicationState} initialState
   */
  async install(initialState) {
    this.#state = initialState;
    // Override for initialization logic
  }

  /**
   * Plugin initialization - override in subclasses
   */
  async initialize() {
    // Override for initialization logic
  }  

  /**
   * Plugin startup - override in subclasses
   */
  async start() {
    // Override for startup logic
  }

  /**
   * Plugin (temporary) stop - override in subclasses
   */
  async stop() {
    // Override for startup logic
  }

  /**
   * Plugin shutdown - override in subclasses
   * Called on window beforeunload
   */
  async shutdown() {
    // Override for cleanup logic
  }

  //
  // State management
  //

  /**
   * React to state changes - override in subclasses
   * @param {string[]} changedKeys - Keys that changed in the state
   */
  async onStateUpdate(changedKeys) {
    // Override for reactive behavior
    // Base implementation is empty - no need to call super()
  }

  //
  // Internal state management
  //

  /**
   * Update internal state reference
   * @param {ApplicationState} newState
   */
  updateInternalState(newState) {
    this.#state = newState;
  }

  //
  // Convenience methods for plugin implementations
  //

  /**
   * Read-only access to current state
   * @returns {ApplicationState|null}
   */
  get state() {
    return this.#state;
  }

  /**
   * Dispatch state changes through the plugin context
   * @param {Partial<ApplicationState>} changes
   * @returns {Promise<ApplicationState>} New state after changes applied
   */
  async dispatchStateChange(changes) {
    if (!this.#state) {
      throw new Error(`Plugin ${this.name} attempted to dispatch state before initialization`);
    }
    
    // Check if plugin state is stale compared to current application state
    const currentAppState = this.context.getCurrentState();
    let stateToUse = this.#state;
    
    if (currentAppState && currentAppState !== this.#state) {
      console.warn(`Warning: Plugin "${this.name}" has stale state. Using current application state instead. This indicates a state synchronization issue that should be investigated.`);
      stateToUse = currentAppState;
    }
    
    const newState = await this.context.updateState(stateToUse, changes);
    this.#state = newState;
    return newState;
  }

  /**
   * Check if specific state keys have changed
   * @param {...keyof ApplicationState} keys
   * @returns {boolean}
   */
  hasStateChanged(...keys) {
    if (!this.#state) {
      return false;
    }
    return this.context.hasStateChanged(this.#state, ...keys);
  }

  /**
   * Get all changed state keys
   * @returns {Array<keyof ApplicationState>}
   */
  getChangedStateKeys() {
    if (!this.#state) {
      return [];
    }
    return this.context.getChangedStateKeys(this.#state);
  }

  /**
   * Get endpoint mappings for this plugin
   * Override in subclasses to provide custom endpoint mappings.
   * Use `...super.getEndpoints()` to include the base lifecycle endpoints.
   * 
   * @example
   * getEndpoints() {
   *   return {
   *     ...super.getEndpoints(),
   *     'state.update': this.handleStateUpdate.bind(this),
   *     'validation.validate': this.validate.bind(this)
   *   };
   * }
   * 
   * @returns {Record<string, Function>} Mapping of endpoint paths to bound methods
   */
  getEndpoints() {
    /** @type {Record<string, Function>} */
    const endpoints = {};
    
    // Standard lifecycle endpoints
    if (typeof this.install === 'function') {
      endpoints['install'] = this.install.bind(this);
    }
    if (typeof this.start === 'function') {
      endpoints['start'] = this.start.bind(this);
    }
    if (typeof this.shutdown === 'function') {
      endpoints['shutdown'] = this.shutdown.bind(this);
    }
    
    // New state management endpoints
    if (typeof this.updateInternalState === 'function') {
      endpoints['updateInternalState'] = this.updateInternalState.bind(this);
    }
    if (typeof this.onStateUpdate === 'function') {
      endpoints['onStateUpdate'] = this.onStateUpdate.bind(this);
    }
    
    return endpoints;
  }

}

export default Plugin;