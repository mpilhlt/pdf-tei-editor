/**
 * Plugin Manager with sophisticated dependency resolution using topological sorting
 */

import Plugin from './plugin-base.js';

/**
 * The minimal plugin configuration object
 * @typedef {Object} PluginConfig
 * @property {string} name - Plugin name
 * @property {string[]} [deps] - Array of plugin names this plugin depends on
 * @property {any} [initialize] - Optional initialization function 
 */

/**
 * Options for plugin endpoint invocation
 * @typedef {Object} InvokeOptions
 * @property {number} [timeout] - Timeout override for this invocation (milliseconds)
 * @property {'parallel'|'sequential'} [mode] - Execution mode: 'parallel' (default) or 'sequential'
 */

/**
 * Plugin Manager with dependency resolution
 */
export class PluginManager {
  constructor(options = {}) {
    /** @type {Map<string, PluginConfig>} */
    this.pluginsByName = new Map();
    
    /** @type {PluginConfig[]} */
    this.registeredPlugins = [];
    
    /** @type {PluginConfig[]} */
    this.dependencyOrderedPlugins = [];
    
    /** @type {Map<string, PluginConfig[]>} */
    this.endpointCache = new Map();
    
    /** @type {Object} */
    this.config = {
      timeout: options.timeout || 2000,
      throws: options.throws || false
    };
    
    /** @type {boolean} */
    this.debug = options.debug || false;

  }

  /**
   * Register a plugin with dependency resolution
   * @param {PluginConfig|Plugin} plugin - Plugin to register (can be Plugin instance or config object)
   * @throws {Error} If plugin is invalid or creates circular dependencies
   */
  register(plugin) {
    // Validate plugin
    if (!plugin || typeof plugin !== 'object') {
      throw new Error('Plugin must be an object');
    }
    
    // Handle Plugin class instances - convert to plugin object
    let pluginConfig;
    if (plugin instanceof Plugin) {
      if (this.debug) {
        console.log(`Converting Plugin instance '${plugin.name}' to plugin object`);
      }
      pluginConfig = this.convertPluginInstance(plugin);
    } else {
      pluginConfig = plugin;
    }
    
    if (!pluginConfig.name || typeof pluginConfig.name !== 'string') {
      console.error('Invalid plugin:', pluginConfig);
      throw new Error('Every plugin must have a name property');
    }
    
    if (this.pluginsByName.has(pluginConfig.name)) {
      throw new Error(`Plugin "${pluginConfig.name}" is already registered`);
    }

    // Normalize dependencies
    const normalizedPlugin = {
      ...pluginConfig,
      deps: Array.isArray(pluginConfig.deps) ? pluginConfig.deps : []
    };

    // Register plugin
    this.pluginsByName.set(pluginConfig.name, normalizedPlugin);
    this.registeredPlugins.push(normalizedPlugin);

    // Clear caches
    this.endpointCache.clear();
    this.dependencyOrderedPlugins = [];

    // Recompute dependency order
    this.computeDependencyOrder();

    // Call initialize function if present
    if (plugin instanceof Plugin) {
      plugin.initialize();
    }

    if (this.debug) {
      console.log(`Registered plugin '${plugin.name}' with dependencies: [${normalizedPlugin.deps.join(', ') || 'none'}]`);
    }
  }

  /**
   * Unregister a plugin
   * @param {string} pluginName - Name of plugin to unregister
   * @throws {Error} If plugin doesn't exist
   */
  unregister(pluginName) {
    const plugin = this.pluginsByName.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin "${pluginName}" doesn't exist`);
    }

    // Remove from all collections
    this.pluginsByName.delete(pluginName);
    this.registeredPlugins = this.registeredPlugins.filter(p => p.name !== pluginName);
    
    // Clear caches and recompute order
    this.endpointCache.clear();
    this.dependencyOrderedPlugins = [];
    this.computeDependencyOrder();
  }

  /**
   * Get a specific plugin by name
   * @param {string} pluginName - Name of plugin to retrieve
   * @returns {PluginConfig|undefined} Plugin definition or undefined if not found
   */
  getPlugin(pluginName) {
    return this.pluginsByName.get(pluginName);
  }

  /**
   * Get plugins that implement a specific endpoint in dependency order
   * @param {string} endpoint - Endpoint path (e.g., 'install', 'state.update')
   * @returns {PluginConfig[]} Array of plugins that implement the endpoint
   */
  getPlugins(endpoint = '.') {
    // Check cache first
    if (this.endpointCache.has(endpoint)) {
      return this.endpointCache.get(endpoint) || [];
    }

    // Filter plugins that have the endpoint and all their dependencies are satisfied
    const filteredPlugins = this.dependencyOrderedPlugins.filter(plugin => {
      // Check if any dependencies are missing
      if (plugin.deps && plugin.deps.length > 0) {
        const missingDependencies = plugin.deps.filter(depName => !this.pluginsByName.has(depName));
        if (missingDependencies.length > 0) {
          console.warn(`Plugin ${plugin.name} is not loaded because its dependencies do not exist: ${missingDependencies.join(', ')}`);
          return false;
        }
      }

      // Check if plugin has the requested endpoint
      if (endpoint === '.') {
        return true; // All plugins
      }

      return this.hasEndpoint(plugin, endpoint);
    });

    // Cache the result
    this.endpointCache.set(endpoint, filteredPlugins);
    return filteredPlugins;
  }

  /**
   * Check if a plugin has a specific endpoint
   * @param {PluginConfig} plugin - Plugin to check
   * @param {string} endpoint - Endpoint path to check
   * @returns {boolean} True if plugin has the endpoint
   * @private
   */
  hasEndpoint(plugin, endpoint) {
    const pathParts = endpoint.split('.');
    let current = plugin;
    
    for (const part of pathParts) {
      if (!current || typeof current !== 'object' || !(part in current)) {
        return false;
      }
      current = current[part];
    }
    
    return true;
  }

  /**
   * Get value at endpoint path in plugin
   * @param {PluginConfig} plugin - Plugin object
   * @param {string} endpoint - Endpoint path
   * @returns {*} Value at endpoint or undefined
   * @private
   */
  getEndpointValue(plugin, endpoint) {
    const pathParts = endpoint.split('.');
    let current = plugin;
    
    for (const part of pathParts) {
      if (!current || typeof current !== 'object' || !(part in current)) {
        return undefined;
      }
      current = current[part];
    }
    
    return current;
  }

  /**
   * Invoke an endpoint on all plugins that implement it, in dependency order
   * @param {string} endpoint - Endpoint to invoke
   * @param {*|Array} [args] - Arguments to pass to endpoint functions. If array, spread as parameters; if not array, pass as single parameter
   * @param {InvokeOptions} [options] - Optional configuration for this invocation
   * @returns {Promise<any[]>} Array of settled results from plugin endpoints
   */
  async invoke(endpoint, args = [], options = {}) {
    if (!endpoint) {
      throw new Error('Invoke requires an endpoint argument');
    }
    
    // Convert args to array for apply() - if it's already an array, use it; otherwise wrap in array
    const invokeArgs = Array.isArray(args) ? args : [args];

    // Parse endpoint flags
    const isNoCall = /^!/.test(endpoint);
    const shouldThrow = this.config.throws || /!$/.test(endpoint);
    const cleanEndpoint = endpoint.replace(/^!|!$/g, '');
    
    // Get the parent object path for method context
    const endpointParts = cleanEndpoint.split('.');
    endpointParts.pop(); // Remove the method name
    const contextPath = endpointParts.join('.');

    // Get plugins that implement this endpoint
    const plugins = this.getPlugins(cleanEndpoint);
    
    // Determine execution mode
    const mode = options.mode || 'parallel';
    
    if (mode === 'sequential') {
      // Sequential execution - respects dependency order
      const results = [];
      
      for (const plugin of plugins) {
        const method = this.getEndpointValue(plugin, cleanEndpoint);
        
        if (typeof method !== 'function' || isNoCall) {
          results.push({ status: 'fulfilled', value: method });
          continue;
        }

        try {
          if (this.debug) {
            console.log('Before', plugin.name, cleanEndpoint, invokeArgs);
          }
          
          // Get the context object for the method
          const context = contextPath ? this.getEndpointValue(plugin, contextPath) : plugin;
          
          // Invoke the method with proper context
          const result = await method.apply(context, invokeArgs);
          
          if (this.debug) {
            console.log('After', plugin.name, cleanEndpoint, 'completed');
          }
          results.push({ status: 'fulfilled', value: result });
        } catch (error) {
          const errorMessage = `Failed to invoke plugin: ${plugin.name}!${cleanEndpoint}`;
          console.error(errorMessage, error);
          
          if (shouldThrow) {
            throw error;
          }
          
          results.push({ status: 'rejected', reason: error });
        }
      }
      
      return results;
    } else {
      // Parallel execution (default behavior)
      const promises = plugins.map(async plugin => {
        const method = this.getEndpointValue(plugin, cleanEndpoint);
        
        if (typeof method !== 'function' || isNoCall) {
          return method;
        }

        try {
          if (this.debug) {
            console.log('Before', plugin.name, cleanEndpoint, invokeArgs);
          }
          
          // Get the context object for the method
          const context = contextPath ? this.getEndpointValue(plugin, contextPath) : plugin;
          
          // Invoke the method with proper context
          const result = method.apply(context, invokeArgs);
          
          if (this.debug) {
            console.log('After', plugin.name, cleanEndpoint, 'completed');
          }
          return result;
        } catch (error) {
          const errorMessage = `Failed to invoke plugin: ${plugin.name}!${cleanEndpoint}`;
          console.error(errorMessage, error);
          
          if (shouldThrow) {
            throw error;
          }
          
          return null;
        }
      });

      // Set up timeout mechanism
      const timeout = options.timeout !== undefined ? options.timeout : this.config.timeout;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, timeout);

      try {
        const result = await Promise.allSettled(promises.map(async (promise) => {
          try {
            return await promise;
          } catch (error) {
            if (error.name === 'AbortError') {
              console.warn(`Plugin endpoint '${endpoint}' timed out after ${timeout}ms`);
            } else {
              console.error(`Error in plugin endpoint ${endpoint}:`, error);
            }
            throw error;
          }
        }));
        return result;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Compute dependency-resolved plugin order using topological sort
   * @throws {Error} If circular dependencies are detected
   * @private
   */
  computeDependencyOrder() {
    const plugins = [...this.registeredPlugins];
    const resolved = [];
    const visiting = new Set();
    const visited = new Set();

    /**
     * Depth-first search for topological sorting
     * @param {PluginConfig} plugin - Plugin to visit
     * @param {string[]} path - Current dependency path (for circular dependency detection)
     */
    const visit = (plugin, path = []) => {
      if (visiting.has(plugin.name)) {
        const cycle = [...path, plugin.name].join(' → ');
        throw new Error(`Circular dependency detected: ${cycle}`);
      }
      
      if (visited.has(plugin.name)) {
        return; // Already processed
      }

      visiting.add(plugin.name);
      
      // Visit all dependencies first
      for (const depName of plugin.deps || []) {
        const dependency = this.pluginsByName.get(depName);
        if (dependency) {
          visit(dependency, [...path, plugin.name]);
        }
        // Missing dependencies are handled in getPlugins()
      }
      
      visiting.delete(plugin.name);
      visited.add(plugin.name);
      resolved.push(plugin);
    };

    // Visit all plugins
    for (const plugin of plugins) {
      if (!visited.has(plugin.name)) {
        visit(plugin);
      }
    }

    this.dependencyOrderedPlugins = resolved;
    
    // Debug output
    const pluginNames = resolved.map(p => p.name);
    if (this.debug) {
      console.log(`🔗 Plugin dependency order: ${pluginNames.join(' → ')}`);
    }
  }

  /**
   * Sort an array by a property (utility method)
   * @param {Array} array - Array to sort
   * @param {string} [sortProperty='order'] - Property to sort by
   */
  sort(array, sortProperty = 'order') {
    array.sort((a, b) => {
      const orderA = a.hasOwnProperty(sortProperty) ? a[sortProperty] : 1000000;
      const orderB = b.hasOwnProperty(sortProperty) ? b[sortProperty] : 1000000;
      return orderA - orderB;
    });
  }

  /**
   * Process raw plugins array (utility method for pre-processing)
   * @param {Function} callback - Function to process the plugins array
   */
  processRawPlugins(callback) {
    callback(this.registeredPlugins);
    this.endpointCache.clear();
    this.computeDependencyOrder();
  }

  /**
   * Convert Plugin instance to plugin object using getEndpoints() method
   * @param {Plugin} pluginInstance - Plugin instance to convert
   * @returns {Object} Plugin configuration object
   * @private
   */
  convertPluginInstance(pluginInstance) {
    const pluginObject = {
      name: pluginInstance.name,
      deps: [...pluginInstance.deps], // Create a copy to avoid reference issues
    };

    // Check if Plugin instance has getEndpoints method
    if (typeof pluginInstance.getEndpoints === 'function') {
      // Use explicit endpoint mapping
      const endpoints = pluginInstance.getEndpoints();
      
      // Apply endpoint mappings to plugin object using dot notation
      for (const [endpointPath, method] of Object.entries(endpoints)) {
        this.setNestedProperty(pluginObject, endpointPath, method);
      }
    }

    return pluginObject;
  }

  /**
   * Set nested property in object using dot notation path
   * @param {Object} obj - Object to set property on
   * @param {string} path - Dot notation path
   * @param {*} value - Value to set
   * @private
   */
  setNestedProperty(obj, path, value) {
    const pathParts = path.split('.');
    let current = obj;
    
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (!(part in current)) {
        current[part] = {};
      }
      current = current[part];
    }
    
    current[pathParts[pathParts.length - 1]] = value;
  }

}

// Export the class
export default PluginManager;