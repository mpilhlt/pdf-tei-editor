/**
 * @file FrontendExtensionPlugin base class
 *
 * Base class for frontend extensions registered by backend plugins.
 * Extensions are loaded as IIFEs (imports stripped) and cannot use ES import,
 * so this base class exposes non-plugin utilities via `getDependency()` using
 * the module registry (see module-registry.js).
 *
 * The class is exposed globally as `window.FrontendExtensionPlugin` before
 * extensions are loaded, so IIFE extension code can extend it via
 * `class MyExt extends window.FrontendExtensionPlugin`.
 *
 * This class adds only what cannot be done via `Plugin` + `getDependency()`:
 * authenticated HTTP calls that need the current session ID from state, and
 * access to the HTML templates the backend plugin ships in its `templates/`
 * directory, which are registered as `<pluginId>:<name>` (see templateId()).
 *
 * @import { PluginContext } from './plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 */

import { Plugin } from './plugin-base.js';
import { createFromTemplate, createSingleFromTemplate, getRegisteredTemplateHtml } from './ui-system.js';

export class FrontendExtensionPlugin extends Plugin {
  /**
   * @param {PluginContext} context
   * @param {{ name?: string, deps?: string[] }} [config]
   */
  constructor(context, config = {}) {
    super(context, config);
  }

  /**
   * Id of the backend plugin that delivered this extension, set by the extension
   * bundle. `undefined` if the class was not loaded from the bundle (e.g. in unit tests).
   * @returns {string|undefined}
   */
  get backendPluginId() {
    return /** @type {{backendPluginId?: string}} */ (/** @type {unknown} */ (this.constructor)).backendPluginId;
  }

  /**
   * Full registry id of one of the backend plugin's templates.
   * @param {string} name - Template name (file stem in the plugin's `templates/` directory)
   * @returns {string} `<pluginId>:<name>`
   * @throws {Error} If the extension was not loaded from the extension bundle
   */
  templateId(name) {
    if (!this.backendPluginId) {
      throw new Error(`Cannot resolve template '${name}': extension ${this.constructor.name} has no backend plugin id`);
    }
    return `${this.backendPluginId}:${name}`;
  }

  /**
   * Create DOM nodes from one of the backend plugin's templates.
   * Named elements become reachable through `getDependency('ui')` when `parentNode` is given;
   * otherwise call `getDependency('ui-system').updateUi()` after inserting the nodes.
   * @param {string} name - Template name
   * @param {Element|Document|null} [parentNode] - If given, the nodes are appended to it
   * @param {Record<string, string|number>} [params] - Values for `${param}` placeholders
   * @returns {ChildNode[]} The created nodes
   */
  createFromTemplate(name, parentNode = null, params = {}) {
    return createFromTemplate(this.templateId(name), parentNode, params);
  }

  /**
   * Create the first element of one of the backend plugin's templates.
   * @param {string} name - Template name
   * @param {Element|Document|null} [parentNode] - If given, the element is appended to it
   * @param {Record<string, string|number>} [params] - Values for `${param}` placeholders
   * @returns {HTMLElement} The created element
   */
  createSingleFromTemplate(name, parentNode = null, params = {}) {
    return createSingleFromTemplate(this.templateId(name), parentNode, params);
  }

  /**
   * Raw HTML of one of the backend plugin's templates.
   * @param {string} name - Template name
   * @returns {string} Template HTML
   */
  getTemplateHtml(name) {
    return getRegisteredTemplateHtml(this.templateId(name));
  }

  /**
   * Call a backend plugin API endpoint with session authentication.
   * @param {string} endpoint - Plugin endpoint path (e.g. '/api/plugins/my-plugin/action')
   * @param {string} [method='GET'] - HTTP method
   * @param {Object|null} [params=null] - Query params for GET, or JSON body for POST/PUT
   * @returns {Promise<Object>} Parsed JSON response
   */
  async callPluginApi(endpoint, method = 'GET', params = null) {
    const url = new URL(endpoint, window.location.origin);
    /** @type {RequestInit} */
    const options = {
      method,
      headers: { 'X-Session-ID': this.state?.sessionId || '' }
    };
    if (params) {
      if (method === 'GET') {
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
      } else {
        options.headers = { ...options.headers, 'Content-Type': 'application/json' };
        options.body = JSON.stringify(params);
      }
    }
    const response = await fetch(url.toString(), options);
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(err.detail || response.statusText);
    }
    return response.json();
  }

  /**
   * Fetch text content from a URL with session authentication.
   * @param {string} url
   * @returns {Promise<string>}
   */
  async fetchText(url) {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'X-Session-ID': this.state?.sessionId || '' }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    return response.text();
  }
}

export default FrontendExtensionPlugin;
