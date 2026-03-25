/**
 * Base Plugin class for class-based plugin architecture
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from './plugin-context.js'
 */

import { createNavigableElement } from './ui-system.js'

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

  /** @type {Map<Function, any>} */
  static instances = new Map();

  /**
   * Create singleton instance of this plugin class
   * @template T
   * @this {new (context: PluginContext) => T}
   * @param {PluginContext} context - Plugin context
   * @returns {T} The singleton instance
   */
  static createInstance(context) {
    if (!Plugin.instances.has(this)) {
      const PluginClass = /** @type {new (context: PluginContext) => T} */ (this);
      Plugin.instances.set(this, new PluginClass(context));
    }
    return /** @type {T} */ (Plugin.instances.get(this));
  }

  /**
   * Get singleton instance of this plugin class
   * @template T
   * @this {new (context: PluginContext) => T}
   * @returns {T} The singleton instance
   */
  static getInstance() {
    const instance = Plugin.instances.get(this);
    if (!instance) {
      throw new Error(`Plugin ${this.name} not instantiated. Call createInstance() first.`);
    }
    return /** @type {T} */ (instance);
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
    // eslint-disable-next-line no-unused-vars
    void changedKeys;
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
   * Returns the public API object for this plugin instance.
   * By default returns `this` (the instance itself is the API).
   * Override when the plugin wraps a separate API object and
   * `getDependency(name)` should return that object instead of the instance.
   * @returns {object}
   */
  getApi() {
    return this;
  }

  /**
   * Create a scoped navigable UI tree from a root element.
   * Wraps createNavigableElement() so plugins can access their own DOM elements
   * without using the global `ui` object:
   *
   * @example
   * const span = createSingleFromTemplate('my-widget')
   * this.#ui = this.createUi(span)
   * // this.#ui.myButton, this.#ui.mySelect, …
   *
   * @template {Element} T
   * @param {T} element - Root element created from a plugin template
   * @returns {T & Record<string, any>} Element with named descendants added as properties
   */
  createUi(element) {
    return createNavigableElement(element);
  }

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
      throw new Error("State hasn't been initialized")
    }
    const newState = await this.context.updateState(changes);
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
      return /** @type {Array<keyof ApplicationState>} */ ([]);
    }
    return /** @type {Array<keyof ApplicationState>} */ (this.context.getChangedStateKeys(this.#state));
  }

  /**
   * Get the public API of another registered plugin by name.
   * Mirrors the backend `context.get_dependency(id)` pattern.
   * Use this instead of static imports of other plugins' APIs.
   * @template {keyof import('../plugin-registry.js').PluginRegistryTypes} N
   * @param {N} name - Plugin name
   * @returns {import('../plugin-registry.js').PluginRegistryTypes[N]} The plugin's public API
   */
  getDependency(name) {
    return this.context.getDependency(name);
  }

  /**
   * Get extension point mappings for this plugin.
   *
   * The base implementation auto-discovers:
   * - Standard lifecycle methods: `install`, `start`, `shutdown`, `updateInternalState`, `onStateUpdate`
   * - Computed methods declared in `static extensionPoints`: each path must have a corresponding
   *   computed method `[ep.ns.name](...args) { return this.method(...args) }`
   * - Per-key state handlers: methods matching `on<Key>Change` are registered as `onStateUpdate.<lowerKey>`
   *
   * @example
   * static extensionPoints = [ep.toolbar.contentItems]
   *
   * [ep.toolbar.contentItems](...args) { return this.getToolbarContentItems(...args) }
   *
   * @example
   * async onXmlChange(newValue, prevValue) { ... }   // called when state.xml changes
   *
   * @returns {Record<string, Function>} Mapping of extension point paths to bound methods
   */
  getExtensionPoints() {
    /** @type {Record<string, Function>} */
    const pts = {};

    // Standard lifecycle extension points
    for (const name of ['install', 'ready', 'start', 'shutdown', 'updateInternalState', 'onStateUpdate']) {
      if (typeof this[name] === 'function') {
        pts[name] = this[name].bind(this);
      }
    }

    // Auto-discover static extensionPoints declarations.
    // Each path must have a corresponding computed method whose key is the full path string:
    //   [ep.toolbar.contentItems]() { return [...] }
    // Methods with dots in their name cannot exist in standard JS, so this[path]
    // resolves only to computed methods — no naming conflicts between EP namespaces.
    const staticPoints = /** @type {typeof Plugin} */ (this.constructor).extensionPoints;
    if (Array.isArray(staticPoints)) {
      for (const path of staticPoints) {
        const value = this[path];
        if (typeof value === 'function') {
          pts[path] = value.bind(this);
        }
      }
    }

    // Auto-discover on<Key>Change methods → register as 'onStateUpdate.<lowerKey>'
    const onChangeRe = /^on([A-Z][a-zA-Z]*)Change$/;
    for (const proto of this.#prototypeChain()) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        const match = onChangeRe.exec(key);
        if (match && typeof this[key] === 'function') {
          const stateKey = match[1].charAt(0).toLowerCase() + match[1].slice(1);
          const epKey = `onStateUpdate.${stateKey}`;
          if (!pts[epKey]) {
            pts[epKey] = this[key].bind(this);
          }
        }
      }
    }

    return pts;
  }

  /**
   * Iterate the prototype chain from this class up to (but not including) Plugin itself.
   * @returns {Iterable<object>}
   */
  * #prototypeChain() {
    let proto = Object.getPrototypeOf(this);
    while (proto && proto !== Plugin.prototype) {
      yield proto;
      proto = Object.getPrototypeOf(proto);
    }
  }

}

export default Plugin;