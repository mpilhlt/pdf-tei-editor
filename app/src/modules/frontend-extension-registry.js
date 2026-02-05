/**
 * @file Frontend Extension Registration System.
 *
 * Extensions are loaded from backend plugins and integrated into the
 * application's PluginManager lifecycle.
 */

import { getSandbox } from './frontend-extension-sandbox.js';

/**
 * @import { FrontendExtensionSandbox } from './frontend-extension-sandbox.js'
 */

/**
 * @typedef {Object} FrontendExtensionDef
 * @property {string} name - Extension name (used as plugin name)
 * @property {string} [description] - Brief description
 * @property {string[]} [deps] - Dependencies on other plugins
 * @property {string} [pluginId] - Backend plugin that provided this extension
 * @property {function(Object, FrontendExtensionSandbox): void} [install] - Install function
 * @property {function(FrontendExtensionSandbox): void} [start] - Start function
 * @property {function(string[], Object, FrontendExtensionSandbox): void} [onStateUpdate] - State update handler
 */

/** @type {FrontendExtensionDef[]} */
const registeredExtensions = [];

/**
 * Register a frontend extension globally.
 * Called by dynamically loaded extension scripts.
 * @param {FrontendExtensionDef} extension
 */
function registerFrontendExtension(extension) {
  if (!extension.name) {
    console.error('Invalid extension: missing name', extension);
    return;
  }

  const existingIndex = registeredExtensions.findIndex(e => e.name === extension.name);
  if (existingIndex >= 0) {
    console.warn(`Extension "${extension.name}" already registered, replacing`);
    registeredExtensions[existingIndex] = extension;
    return;
  }

  registeredExtensions.push(extension);
  console.log(`Registered frontend extension: ${extension.name} (from ${extension.pluginId || 'unknown'})`);
}

/**
 * Get all registered extensions
 * @returns {FrontendExtensionDef[]}
 */
function getExtensions() {
  return [...registeredExtensions];
}

/**
 * Clear all registered extensions (for testing)
 */
function clearExtensions() {
  registeredExtensions.length = 0;
}

/**
 * Convert a frontend extension to a PluginManager-compatible plugin object.
 * @param {FrontendExtensionDef} extension
 * @returns {Object} Plugin object for PluginManager
 */
function wrapExtensionAsPlugin(extension) {
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
 * Load frontend extensions from the server and register them with the PluginManager.
 * Fetches the extensions bundle, executes it to register extensions via
 * window.registerFrontendExtension, then wraps and registers them as plugins.
 *
 * @param {Object} pluginManager - PluginManager instance to register extensions with
 * @returns {Promise<number>} Number of extensions registered
 */
async function loadExtensionsFromServer(pluginManager) {
  console.log('DEBUG loadExtensionsFromServer() called');
  try {
    const response = await fetch('/api/v1/plugins/extensions.js');
    if (!response.ok) {
      console.warn(`Failed to load frontend extensions: HTTP ${response.status}`);
      return 0;
    }

    const script = await response.text();
    console.log('DEBUG loadExtensionsFromServer: fetched script, length:', script.length);

    // Execute the script to register extensions via window.registerFrontendExtension
    const scriptEl = document.createElement('script');
    scriptEl.textContent = script;
    document.head.appendChild(scriptEl);
    document.head.removeChild(scriptEl);

    // Get registered extensions and wrap them as plugins
    const rawExtensions = getExtensions();
    console.log('DEBUG loadExtensionsFromServer: raw extensions:', rawExtensions.map(e => ({ name: e.name, deps: e.deps })));
    let registered = 0;

    for (const extension of rawExtensions) {
      try {
        const extensionPlugin = wrapExtensionAsPlugin(extension);
        pluginManager.register(extensionPlugin);
        console.log(`DEBUG Registered frontend extension: ${extensionPlugin.name} with deps:`, extensionPlugin.deps);
        registered++;
      } catch (error) {
        console.error(`Failed to register extension ${extension.name}:`, error);
      }
    }

    return registered;
  } catch (error) {
    console.warn('Failed to load frontend extensions:', error);
    return 0;
  }
}

// Expose global registration function
window.registerFrontendExtension = registerFrontendExtension;

export { registerFrontendExtension, getExtensions, clearExtensions, loadExtensionsFromServer };
