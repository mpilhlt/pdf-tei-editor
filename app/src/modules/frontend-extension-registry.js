/**
 * @file Frontend Extension Registration System.
 *
 * Extensions are loaded from backend plugins and integrated into the
 * application's PluginManager lifecycle as class-based Plugin instances.
 *
 * Each extension is a class that extends FrontendExtensionPlugin and is
 * delivered as an IIFE that calls window.registerFrontendExtension(ClassName).
 */

/** @import { PluginContext } from './plugin-context.js' */

/** @type {Array<{ExtensionClass: Function, pluginId: string}>} */
const registeredExtensions = [];

/**
 * Register a frontend extension class globally.
 * Called by dynamically loaded extension IIFEs.
 * @param {Function} ExtensionClass - Class constructor extending FrontendExtensionPlugin
 * @param {string} [pluginId] - Backend plugin that provided this extension (for logging)
 */
function registerFrontendExtension(ExtensionClass, pluginId = 'unknown') {
  if (typeof ExtensionClass !== 'function') {
    console.error('Invalid extension: expected a class constructor', ExtensionClass);
    return;
  }

  const name = ExtensionClass.name;

  const existingIndex = registeredExtensions.findIndex(
    e => e.ExtensionClass === ExtensionClass
  );
  if (existingIndex >= 0) {
    console.warn(`Extension "${name}" already registered, replacing`);
    registeredExtensions[existingIndex] = { ExtensionClass, pluginId };
    return;
  }

  registeredExtensions.push({ ExtensionClass, pluginId });
  console.log(`Registered frontend extension: ${name} (from ${pluginId})`);
}

/**
 * Get all registered extension entries.
 * @returns {Array<{ExtensionClass: Function, pluginId: string}>}
 */
function getExtensions() {
  return [...registeredExtensions];
}

/**
 * Clear all registered extensions (for testing).
 */
function clearExtensions() {
  registeredExtensions.length = 0;
}

/**
 * Load frontend extensions from the server and register them with the PluginManager.
 * Fetches the extensions bundle, executes it (triggering window.registerFrontendExtension
 * calls), then instantiates and registers each extension class as a Plugin.
 *
 * @param {Object} pluginManager - PluginManager instance
 * @param {PluginContext} context - PluginContext for instantiating Plugin subclasses
 * @returns {Promise<number>} Number of extensions registered
 */
async function loadExtensionsFromServer(pluginManager, context) {
  try {
    const response = await fetch('/api/v1/plugins/extensions.js');
    if (!response.ok) {
      console.warn(`Failed to load frontend extensions: HTTP ${response.status}`);
      return 0;
    }

    const script = await response.text();

    // Execute the bundle — each IIFE calls window.registerFrontendExtension(ClassName)
    const scriptEl = document.createElement('script');
    scriptEl.textContent = script;
    document.head.appendChild(scriptEl);
    document.head.removeChild(scriptEl);

    const extensions = getExtensions();
    let registered = 0;

    for (const { ExtensionClass, pluginId } of extensions) {
      try {
        const instance = ExtensionClass.createInstance(context);
        pluginManager.register(instance);
        registered++;
      } catch (error) {
        console.error(`Failed to register extension from ${pluginId}:`, error);
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
