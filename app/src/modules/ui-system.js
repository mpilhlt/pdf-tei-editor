/**
 * UI System - Template registration and DOM element utilities
 * 
 * This module provides a lightweight template registration system that supports
 * both development and production modes:
 * - In development (?dev mode): Templates are loaded dynamically from files
 * - In production: Templates are bundled into templates.json for performance
 */

import { updateUi } from '../ui.js';


// Template registry for caching
const templateRegistry = new Map();
const isDev = new URLSearchParams(window.location.search).has('dev');
let templatesJson = null;

/**
 * Registers a template with the system. In development mode, this loads
 * and caches the template immediately. In production mode, this loads
 * from the bundled JSON.
 * 
 * @param {string} id - Unique template identifier
 * @param {string} pathOrHtml - Template file path (dev) or HTML content
 * @returns {Promise<void>}
 */
export async function registerTemplate(id, pathOrHtml) {
  if (templateRegistry.has(id)) {
    console.warn(`Template '${id}' is already registered, overwriting`);
  }
  
  const template = {
    id,
    pathOrHtml,
    cached: false,
    html: ''
  };
  
  // Pre-load the HTML content
  template.html = await getTemplateHtml(id, template);
  template.cached = true;
  
  templateRegistry.set(id, template);
}

/**
 * Loads templates.json in production mode
 * @returns {Promise<Object>} The templates object
 */
async function loadTemplatesJson() {
  if (!templatesJson) {
    try {
      const response = await fetch('templates.json');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      templatesJson = await response.json();
    } catch (error) {
      console.error('Failed to load templates.json, falling back to development mode:', error);
      templatesJson = {};
    }
  }
  return templatesJson;
}

/**
 * Gets HTML content for a template, handling both dev and production modes
 * 
 * @param {string} id - Template identifier
 * @param {object} [template] - Template object (if not provided, looks up in registry)
 * @returns {Promise<string>} The HTML content
 */
async function getTemplateHtml(id, template = null) {
  if (!template) {
    template = templateRegistry.get(id);
  }
  
  if (!template) {
    throw new Error(`Template '${id}' is not registered. Available templates: ${Array.from(templateRegistry.keys()).join(', ')}`);
  }
  
  // Return cached HTML if available
  if (template.cached && template.html) {
    return template.html;
  }
  
  let html;
  
  if (isDev) {
    // Development mode: load from file system
    if (template.pathOrHtml.trim()[0] === '<') {
      // Literal HTML
      html = template.pathOrHtml.trim();
    } else {
      // File path - add /src/templates/ prefix if not absolute
      const path = template.pathOrHtml.startsWith('/') 
        ? template.pathOrHtml 
        : '/src/templates/' + template.pathOrHtml;
      
      console.log('Loading template from', path);
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Failed to load template '${id}' from '${path}': ${response.status} ${response.statusText}`);
      }
      html = await response.text();
    }
  } else {
    // Production mode: load from bundled JSON
    const templates = await loadTemplatesJson();
    html = templates[id];
    
    if (!html) {
      throw new Error(`Template '${id}' not found in templates.json. Available templates: ${Object.keys(templates).join(', ')}`);
    }
  }
  
  return html.trim();
}

/**
 * Replaces template parameters in HTML content using ${param} syntax
 * 
 * @param {string} html - HTML content with parameters
 * @param {Object} params - Parameter values to substitute
 * @returns {string} HTML with parameters replaced
 */
function replaceTemplateParameters(html, params = {}) {
  if (!params || Object.keys(params).length === 0) {
    return html;
  }
  
  return html.replace(/\$\{(\w+)\}/g, (match, paramName) => {
    if (params.hasOwnProperty(paramName)) {
      return String(params[paramName]);
    }
    console.warn(`Template parameter '${paramName}' not provided, leaving as-is`);
    return match;
  });
}

/**
 * Creates DOM elements from a registered template with optional parameter substitution.
 * Template must be registered first with registerTemplate(). If a parentNode is given, 
 * the elements are appended to it. If no parentNode is given, the generated nodes are 
 * returned as an array.
 * 
 * @param {string} id - Template identifier
 * @param {Element|Document|null} [parentNode] - If given, appends generated nodes as children
 * @param {Object} [params] - Parameters for template substitution (e.g., {name: 'icon-name'})
 * @returns {ChildNode[]} All the created nodes in an array
 */
export function createFromTemplate(id, parentNode = null, params = {}) {
  const template = templateRegistry.get(id);
  
  if (!template) {
    throw new Error(`Template '${id}' is not registered. Available templates: ${Array.from(templateRegistry.keys()).join(', ')}`);
  }
  
  if (!template.cached || !template.html) {
    throw new Error(`Template '${id}' is not loaded. Make sure to await registerTemplate() before using createFromTemplate().`);
  }
  
  const processedHtml = replaceTemplateParameters(template.html, params);
  
  const div = document.createElement('div');
  div.innerHTML = processedHtml;
  const nodes = Array.from(div.childNodes);
  
  // If a parent node has been given, add nodes to it and update UI
  if (parentNode instanceof Element) {
    parentNode.append(...nodes);
    updateUi();
  }
  
  return nodes;
}

/**
 * Creates a single DOM element from a registered template with optional parameter substitution.
 * Template must be registered first with registerTemplate(). If the template produces multiple
 * elements, returns the first one. If a parentNode is given, the element is appended to it. 
 * 
 * @param {string} id - Template identifier
 * @param {Element|Document|null} [parentNode] - If given, appends generated element as child
 * @param {Object} [params] - Parameters for template substitution (e.g., {name: 'icon-name'})
 * @returns {HTMLElement} The first created element
 * @throws {Error} If template produces no elements
 */
export function createSingleFromTemplate(id, parentNode = null, params = {}) {
  const nodes = createFromTemplate(id, parentNode, params);
  
  if (nodes.length === 0) {
    throw new Error(`Template '${id}' produced no elements.`);
  }
 
  let element = Array.from(nodes).find(elem => elem instanceof HTMLElement);
  if (element) {
    return element
  }
  throw new Error(`Could not find an html element in the template with id ${id}.`)
}

/**
 * Legacy function - creates HTML elements from templates or literal HTML strings.
 * 
 * @deprecated Use registerTemplate() + createFromTemplate() instead
 * @param {string} htmlOrFile A literal html string or the name of a file in the 'app/src/templates/' folder  
 * @param {Element|Document|null} [parentNode] If given, appends the generated nodes as children to the parentNode
 * @returns {Promise<ChildNode[]>} All the created nodes in an array
 */
export async function createHtmlElements(htmlOrFile, parentNode = null) {
  let html;
  if (htmlOrFile.trim()[0] === '<') {
    // interpret as literal html
    html = htmlOrFile.trim();
  } else {
    // treat as path
    const path = '/src/templates/' + htmlOrFile;
    console.log('Loading HTML from', path);
    html = await (await fetch(path)).text();
  }
  
  const div = document.createElement('div');
  div.innerHTML = html.trim();
  const nodes = Array.from(div.childNodes);
  
  // if a parent node has been given, add nodes to it
  if (parentNode instanceof Element) {
    parentNode.append(...nodes);
  }
  
  return nodes;
}

/**
 * Finds all descendants of a given node that have a "name" attribute,
 * but does not recurse into those nodes. This means descendants of the
 * named nodes are excluded. If duplicate names are found, the first
 * occurrence is used.
 *
 * @param {Element|Document} node The starting node to search from.
 * @returns {Object<string, Element>} An object mapping name attribute values to their respective nodes.
 */
function findNamedDescendants(node) {
  const results = {};

  /**
   * Recursive function that adds to the results object
   * @param {Element|Document} currentNode 
   * @returns {void}
   */
  function traverse(currentNode) {
    if (!currentNode || !currentNode.childNodes) {
      return;
    }

    for (let i = 0; i < currentNode.childNodes.length; i++) {
      /** @type {Element} */
      const childNode = /** @type {Element} */(currentNode.childNodes[i]);
      // Check if it's an element (important to avoid text nodes)
      if (childNode.nodeType === Node.ELEMENT_NODE) {

        const nameAttribute = childNode.getAttribute("name");

        if (nameAttribute && !results.hasOwnProperty(nameAttribute)) {
          results[nameAttribute] = childNode;
        } else {
          // Only recurse if the current node doesn't have a name attribute
          // or if the name is already in the results. This prevents
          // recursion into named nodes.
          traverse(childNode);
        }
      }
    }
  }
  traverse(node);
  return /** @type {{ [x: string]: Element }} */(results);
}

/**
 * Creates a navigable element by adding named descendant elements as properties.
 * Each property gives direct access to the DOM element (which is also the navigation object).
 * You must be careful to use names that do not override existing properties.
 *
 * @template {Element|Document} T
 * @param {T} node The element to enhance with navigation
 * @returns {T & Record<string, any>} The element with added navigation properties
 */
export function createNavigableElement(node) {
  const namedDescendants = findNamedDescendants(node);
  for (let name in namedDescendants) {
    namedDescendants[name] = createNavigableElement(namedDescendants[name]);
  }
  const modifiedObj = Object.assign(node, namedDescendants);
  return modifiedObj;
}

/**
 * Gets all registered template IDs
 * @returns {string[]} Array of template IDs
 */
export function getRegisteredTemplates() {
  return Array.from(templateRegistry.keys());
}

/**
 * Clears the template cache (useful for testing)
 */
export function clearTemplateCache() {
  for (let template of templateRegistry.values()) {
    template.cached = false;
    template.html = null;
  }
  templatesJson = null;
}