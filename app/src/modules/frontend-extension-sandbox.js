/**
 * @file Frontend Extension Sandbox
 *
 * Provides controlled API access for frontend extensions loaded from backend plugins.
 * Extensions receive this sandbox in all lifecycle methods (install, start, onStateUpdate).
 *
 * Note: This is different from PluginSandbox (backend-plugin-sandbox.js) which handles
 * inter-window communication for plugin HTML content displayed in iframes/dialogs.
 * This sandbox provides direct API access for extensions running in the main window.
 */

/**
 * @import { XslStylesheetRegistration } from '../plugins/xsl-viewer.js'
 */

import ui from '../ui.js';
import { dialog as dialogApi, services, client, config as configApi, sse as sseApi, fileselection, XslViewerPlugin } from '../plugins.js';
import { notify } from './sl-utils.js';
import * as teiUtilsApi from './tei-utils.js';

/**
 * @typedef {Object} FrontendExtensionSandbox
 * @property {import('../ui.js').namedElementsTree} ui - UI element tree
 * @property {Object} dialog - Dialog API (info, error, success, confirm, prompt)
 * @property {function(string, string, string): void} notify - Notification function
 * @property {function(): Object} getState - Get current application state
 * @property {function(Partial<Object>): Promise<Object>} updateState - Update application state
 * @property {function(string, any, Object): Promise<any>} invoke - Invoke PluginManager endpoint
 * @property {Object} services - Application services (load, showMergeView, reloadFiles)
 * @property {Object} sse - SSE event bus (addEventListener, removeEventListener)
 * @property {Object} api - API client for backend calls
 * @property {{ get: function(string, any=): Promise<any> }} config - Configuration API
 * @property {function(string): Promise<string>} fetchText - Fetch text content from URL
 * @property {function(string, string=, Object=): Promise<Object>} callPluginApi - Call plugin API endpoint with authentication
 * @property {function(XslStylesheetRegistration): void} registerXslStylesheet - Register XSL stylesheet
 * @property {function(string): Object|undefined} getPluginApi - Get the api export of a registered frontend plugin by name
 * @property {typeof import('./tei-utils.js')} teiUtils - TEI utility functions (e.g., encodeXmlEntities)
 */

/** @type {function(): Object} */
let getStateFn = () => ({});

/** @type {function(string, any, Object): Promise<any>} */
let invokeFn = async () => undefined;

/** @type {function(Partial<Object>): Promise<Object>} */
let updateStateFn = async (changes) => changes;

/**
 * Initialize sandbox with state getter, invoke function, and updateState function.
 * Called by Application during initialization.
 * @param {function(): Object} stateFn - Function to get current state
 * @param {function(string, any, Object): Promise<any>} invokeFunction - PluginManager invoke function
 * @param {function(Partial<Object>): Promise<Object>} updateStateFunction - App updateState function
 */
export function initializeSandbox(stateFn, invokeFunction, updateStateFunction) {
  getStateFn = stateFn;
  invokeFn = invokeFunction;
  if (updateStateFunction) {
    updateStateFn = updateStateFunction;
  }
}

/**
 * Fetch text content from a URL with session authentication.
 * @param {string} url - URL to fetch (can be absolute or relative)
 * @returns {Promise<string>} Text content
 */
async function fetchText(url) {
  const state = getStateFn();
  const sessionId = state.sessionId || '';

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Session-ID': sessionId
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

/**
 * Call a plugin API endpoint with authentication.
 * @param {string} endpoint - Plugin endpoint path (e.g., '/api/plugins/my-plugin/action')
 * @param {string} [method='GET'] - HTTP method (GET, POST, etc.)
 * @param {Object|null} [params=null] - Query params for GET or request body for POST/PUT
 * @returns {Promise<Object>} Parsed JSON response
 */
async function callPluginApi(endpoint, method = 'GET', params = null) {
  const state = getStateFn();
  const url = new URL(endpoint, window.location.origin);
  /** @type {RequestInit} */
  const options = {
    method,
    headers: { 'X-Session-ID': state?.sessionId || '' }
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
 * Register an XSL stylesheet with the XslViewerPlugin.
 * @param {XslStylesheetRegistration} options - Stylesheet registration options
 */
function registerXslStylesheet(options) {
  try {
    const xslViewer = XslViewerPlugin.getInstance();
    xslViewer.register(options);
  } catch (error) {
    console.warn('XslViewerPlugin not available:', error.message);
  }
}

/**
 * Get the sandbox instance for extensions.
 * @returns {FrontendExtensionSandbox}
 */
export function getSandbox() {
  return {
    ui,
    dialog: dialogApi,
    notify,
    getState: getStateFn,
    updateState: updateStateFn,
    invoke: invokeFn,
    services: {
      load: services.load,
      showMergeView: services.showMergeView,
      reloadFiles: (options) => fileselection.reload(options)
    },
    sse: {
      addEventListener: sseApi.addEventListener,
      removeEventListener: sseApi.removeEventListener
    },
    api: client.apiClient,
    config: { get: configApi.get },
    fetchText,
    callPluginApi: (endpoint, method, params) => callPluginApi(endpoint, method, params),
    registerXslStylesheet
  };
}
