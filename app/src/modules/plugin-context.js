/**
 * PluginContext - Facade providing clean interface between plugins and application
 * @import { ApplicationState } from '../app.js'
 * @import { Application } from '../modules/application.js'
 * @import {InvokeOptions} from '../modules/plugin-manager.js'
 */ 

/**
 * PluginContext provides a controlled interface for plugins to interact with application services
 * without creating tight coupling to the full Application class
 */
export class PluginContext {
  constructor(application) {
    this.#application = application;
  }

  /** @type {Application} */
  #application;

  //
  // State management methods
  //

  /**
   * Update application state
   * @param {ApplicationState} currentState - Current state
   * @param {Partial<ApplicationState>} changes - Changes to apply
   * @returns {Promise<ApplicationState>} New state after changes applied
   */
  async updateState(currentState, changes) {
    return await this.#application.updateState(currentState, changes);
  }

  /**
   * Update extension properties in state
   * @param {ApplicationState} currentState - Current state
   * @param {Object} extChanges - Extension properties to update
   * @returns {Promise<ApplicationState>} New state after changes applied
   */
  async updateStateExt(currentState, extChanges) {
    return await this.#application.updateStateExt(currentState, extChanges);
  }

  /**
   * Check if specific state properties have changed
   * @param {ApplicationState} state - Current state
   * @param {...string} keys - Keys to check for changes
   * @returns {boolean} True if any keys have changed
   */
  hasStateChanged(state, ...keys) {
    return this.#application.getStateManager().hasStateChanged(state, ...keys);
  }

  /**
   * Get all property names that have changed from previous state
   * @param {ApplicationState} state - Current state
   * @returns {Array<keyof ApplicationState>} Array of changed property names
   */
  getChangedStateKeys(state) {
    return this.#application.getStateManager().getChangedStateKeys(state);
  }

  /**
   * Get previous value of a state property
   * @param {ApplicationState} state - Current state
   * @param {string} propertyName - Property name to get previous value for
   * @returns {*} Previous value or undefined
   */
  getPreviousStateValue(state, propertyName) {
    return this.#application.getStateManager().getPreviousStateValue(state, propertyName);
  }

  /**
   * Get the previous state object
   * @param {ApplicationState} state - Current state
   * @returns {ApplicationState|undefined} Previous state or undefined
   */
  getPreviousState(state) {
    return this.#application.getStateManager().getPreviousState(state);
  }

  //
  // Plugin invocation methods (for inter-plugin communication)
  //

  /**
   * Invoke an endpoint on all plugins that implement it, in dependency order.
   * By default, throws on the first error encountered, and returns the value of the 
   * first fulfilled promise (or synchronous function). For other options, see {InvokeOptions}
   * 
   * @param {string} endpoint - Endpoint to invoke
   * @param {*|Array} [args] - Arguments to pass to endpoint functions. If array, spread as parameters; if not array, pass as single parameter
   * @param {InvokeOptions} [options] - Optional configuration for this invocation
   * @returns {Promise<InvocationResult[] | any[] | any>} Result formatted depending on options.result
   */
  async invokePluginEndpoint(endpoint, args = [], options = {throws:true, result:'full'}) {
    return await this.#application.invokePluginEndpoint(endpoint, args, options);
  }

  //
  // Utility methods plugins might need
  //

  /**
   * Get current application state (read-only access)
   * @returns {ApplicationState|null} Current application state
   */
  getCurrentState() {
    return this.#application.getCurrentState();
  }
}

export default PluginContext;