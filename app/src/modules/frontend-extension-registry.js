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

import { addTemplateHtml } from './ui-system.js';

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
  // Read by FrontendExtensionPlugin.backendPluginId to prefix template ids
  /** @type {any} */ (ExtensionClass).backendPluginId = pluginId;

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
 * Register the HTML templates of a backend plugin.
 * Called by the extension bundle ahead of the plugin's extensions, so the templates
 * exist before any extension is installed. Each template is stored as `pluginId:name`.
 * @param {string} pluginId - Backend plugin id
 * @param {Record<string, string>} templates - Template HTML by template name (file stem)
 */
function registerFrontendExtensionTemplates(pluginId, templates) {
  for (const [name, html] of Object.entries(templates)) {
    addTemplateHtml(`${pluginId}:${name}`, html);
  }
}

/**
 * Add or replace the stylesheet of a backend plugin as a `<style data-plugin="...">`
 * element in the document head. Called by the extension bundle ahead of the
 * plugin's extensions.
 * @param {string} pluginId - Backend plugin id
 * @param {string} css - Stylesheet text
 */
function registerFrontendExtensionStyles(pluginId, css) {
  const existing = Array.from(document.head.querySelectorAll('style[data-plugin]'))
    .find(el => el.getAttribute('data-plugin') === pluginId);
  const style = existing ?? document.createElement('style');
  style.setAttribute('data-plugin', pluginId);
  style.textContent = css;
  if (!existing) document.head.appendChild(style);
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
window.registerFrontendExtensionTemplates = registerFrontendExtensionTemplates;
window.registerFrontendExtensionStyles = registerFrontendExtensionStyles;

export {
  registerFrontendExtension,
  registerFrontendExtensionTemplates,
  registerFrontendExtensionStyles,
  getExtensions,
  clearExtensions,
  loadExtensionsFromServer
};
