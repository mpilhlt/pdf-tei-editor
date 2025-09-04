/**
 * Utility functions for plugin management and state handling
 */

import pluginManager from "./plugin.js"

export {pluginManager}

/**
 * Invoke an endpoint on all registered plugins with timeout support
 * @param {string} endpoint - The endpoint string to invoke
 * @param {any} [param] - Optional parameter to pass to the endpoint
 * @param {Object} options - Options object with timeout
 * @returns {Promise<any[]>} Array of settled results from all plugins
 */
export async function invoke(endpoint, param=null, options = {}) {
  // get all promises (or sync results) from the endpoints
  const promises = pluginManager.invoke(endpoint, param)
    // Set up a timeout mechanism so that the app doesn't hang if a promise does not resolve quickly or ever
  const timeout = options.timeout !== undefined ? options.timeout : 2000;
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
