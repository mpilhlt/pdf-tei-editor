/**
 * @file Frontend Extension Wrapper
 *
 * Wraps frontend extensions as plugin objects for PluginManager integration.
 */

import { getExtensions } from './frontend-extension-registry.js';
import { getSandbox } from './frontend-extension-sandbox.js';

/**
 * @import { FrontendExtensionDef } from './frontend-extension-registry.js'
 */

/**
 * Convert a frontend extension to a PluginManager-compatible plugin object.
 * @param {FrontendExtensionDef} extension
 * @returns {Object} Plugin object for PluginManager
 */
export function wrapExtensionAsPlugin(extension) {
  const sandbox = getSandbox();

  // Standard lifecycle methods that need sandbox injection
  const lifecycleMethods = ['install', 'start', 'onStateUpdate'];

  const plugin = {
    name: extension.name,
    deps: extension.deps || [],
  };

  // Wrap lifecycle methods to inject sandbox as last argument
  if (extension.install) {
    plugin.install = (state) => extension.install(state, sandbox);
  }

  if (extension.start) {
    plugin.start = () => extension.start(sandbox);
  }

  if (extension.onStateUpdate) {
    plugin.onStateUpdate = (changedKeys, state) =>
      extension.onStateUpdate(changedKeys, state, sandbox);
  }

  // Include custom endpoints with sandbox injection
  for (const [key, value] of Object.entries(extension)) {
    if (typeof value === 'function' && !lifecycleMethods.includes(key) && key !== 'name') {
      plugin[key] = (...args) => value(...args, sandbox);
    }
  }

  return plugin;
}

/**
 * Get all extensions wrapped as plugin objects.
 * @returns {Object[]} Array of plugin objects
 */
export function getWrappedExtensions() {
  return getExtensions().map(wrapExtensionAsPlugin);
}
