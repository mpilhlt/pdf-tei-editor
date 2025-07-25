
/**
 * "Mini-jquery" - monkey-patches the element identified by the selector with some convenience methods.
 * @param {string} selector 
 * @returns {Element}
 */
export function $(selector) {
  const node = document.querySelector(selector)
  if (!node) {
    throw new Error(`Selector "${selector} does not find any element"`)
  }
  return node
}

/**
 * Given a selector, return all matching DOM nodes in an array
 * @param {string} selector The DOM selector
 * @returns {Array}
 */
export function $$(selector) {
  return Array.from(document.querySelectorAll(selector))
}

export class CookieStorage {
  /**
   * Constructor for CookieStorage.
   * @param {object} [config={}] - Configuration for cookies.
   * @param {string} [config.path='/'] - The default path for cookies.
   * @param {boolean} [config.secure=true] - Whether cookies should be secure.
   * @param {string} [config.sameSite='Strict'] - The SameSite attribute (e.g., 'Strict', 'Lax', or 'None').
   * @param {number} [config.maxAge=604800] - The default max-age for cookies (in seconds, default is 7 days).
   */
  constructor(config = {}) {
    this.config = {
      path: config.path || '/',
      secure: config.secure !== undefined ? config.secure : true,
      sameSite: config.sameSite || 'Strict',
      maxAge: config.maxAge !== undefined ? config.maxAge : 7 * 24 * 60 * 60 // Default: 7 days
    };
  }

  /**
   * Retrieves a value from cookies by key. If it can be converted from a
   * JSON string, return the converted value.
   * @param {string} key - The key of the cookie to retrieve.
   * @returns {string|Object|null} The cookie value, or null if not found.
   */
  get(key) {
    const cookie = document.cookie
      .split('; ')
      .find(row => row.startsWith(`${key}=`));
    let value = cookie ? decodeURIComponent(cookie.split('=')[1]) : null;
    if (value && typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch (e) {
        // just keep the old value
      }
    }
    return value;
  }

  /**
   * Returns true if the key exists in the cookies or false if not. 
   * @param {string} key The key of the hash parameter to retrieve.
   * @returns {boolean}
   */
  has(key) {
    return this.get(key) !== null;
  }

  /**
   * Sets a cookie with a specified key and value. If it is not a string,
   * JSON-encode it before storing it. 
   * @param {string} key - The key of the cookie.
   * @param {string|Object} value - The value of the cookie.
   * @param {object} [options={}] - Optional overrides for the configuration.
   */
  set(key, value, options = {}) {
    if (typeof value != "string") {
      value = JSON.stringify(value);
    }
    const { path, secure, sameSite, maxAge } = { ...this.config, ...options };
    let cookie = `${key}=${encodeURIComponent(value)}; path=${path}; samesite=${sameSite}`;
    if (secure) cookie += '; secure';
    if (maxAge !== undefined) cookie += `; max-age=${maxAge}`;
    document.cookie = cookie;
  }

  /**
   * Removes a cookie by key.
   * @param {string} key - The key of the cookie to remove.
   * @param {object} [options={}] - Optional overrides for the configuration.
   */
  remove(key, options = {}) {
    const { path, sameSite } = { ...this.config, ...options };
    const cookie = `${key}=; path=${path}; samesite=${sameSite}; max-age=0`;
    document.cookie = cookie;
  }
}


export class UrlHash {

  /**
   * Sets or updates a hash parameter in the URL without reloading the page and ensures browser history is updated.
   * @param {string} key - The key of the hash parameter to set.
   * @param {string} value - The value of the hash parameter to set.
   */
  static set(key, value) {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    hash.set(key, value);

    // Use history.pushState to store the previous state in the browser's history
    history.pushState(null, '', '#' + hash.toString());
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }

  /**
   * Retrieves the value of a hash parameter from the URL.
   * @param {string} key - The key of the hash parameter to retrieve.
   * @returns {string|null} The value of the hash parameter, or null if not found.
   */
  static get(key) {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    return hash.get(key);
  }

  /**
   * Returns true if the key exists in the URL hash or false if not
   * @param {string} key The key of the hash parameter to retrieve.
   * @returns  {boolean}
   */
  static has(key) {
    return UrlHash.get(key) !== null;
  }

  /**
   * Removes a hash parameter from the URL without reloading the page.
   * @param {string} key - The key of the hash parameter to remove.
   */
  static remove(key) {
    if (!UrlHash.has(key)) return; // Do nothing if the key does not exist
    const hash = new URLSearchParams(window.location.hash.slice(1));
    hash.delete(key); // Remove the specified key
    const updatedHash = hash.toString();
    window.location.hash = updatedHash ? updatedHash : ''; // Update the hash or clear it
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
}

/**
 * Selects the option in the selectbox of which the value property matches the given value
 * @param {HTMLSelectElement} selectbox The selectbox
 * @param {string} value The value to select
 */
export function selectByValue(selectbox, value) {
  const index = Array.from(selectbox.options).findIndex(o => o.value === value)
  if (index == -1) {
    throw new Error(`No matching option with value '${value}' in selectbox with name '${selectbox.name}'`)
  }
  selectbox.selectedIndex = index;
}

/**
 * Selects the option in the selectbox of which the given data property matches the given value
 * @param {HTMLSelectElement} selectbox The selectbox
 * @param {string} key The key of the dataset property
 * @param {string} value The value to select
 */
export function selectByData(selectbox, key, value) {
  const index = Array.from(selectbox.options).findIndex(o => o.dataset[key] === value)
  if (index == -1) {
    throw new Error(`No matching option with dataset.${key} value '${value}' in selectbox with name '${selectbox.name}'`)
  }
  selectbox.selectedIndex = index;
}

/**
 * Returns the first descendant having that name. Throws an error if none can be found unless you pass noError = true
 * @param {Element} node The ancestor node
 * @param {string} name The name to look for
 * @param {Boolean} noError If true, return null instead of throwing an error if no ancestor with that name exists
 * @returns {Element|null}
 */
export function getDescendantByName(node, name, noError) {
  const descendant = node.querySelector(`[name="${name}]`)
  if (!descendant) {
    if (noError) return null
    throw new Error(`No descendant with name "${name} exists`)
  }
  return descendant
}



/**
 * Escapes the given text to valid html
 * @param {string} text 
 * @returns {string} The escaped text
 */
export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Finds all descendants of a given node that have a "name" attribute,
 * but does not recurse into those nodes.  This means descendants of the
 * named nodes are excluded.  If duplicate names are found, the first
 * occurrence is used.
 *
 * @param {Element} node The starting node to search from.
 * @returns {Object<string, Element>} An object mapping name attribute values to their respective nodes.
 */
function findNamedDescendants(node) {
  const results = {};

  /**
   * Recursive function that adds to the results object
   * @param {Element} currentNode 
   * @returns {void}
   */
  function traverse(currentNode) {
    if (!currentNode || !currentNode.childNodes) {
      return;
    }

    for (let i = 0; i < currentNode.childNodes.length; i++) {
      /** @type {Element} */
      // @ts-ignore
      const childNode = currentNode.childNodes[i];
      // Check if it's an element (important to avoid text nodes)
      if (childNode.nodeType === Node.ELEMENT_NODE) {

        const nameAttribute = childNode.getAttribute("name");

        if (nameAttribute && !results.hasOwnProperty(nameAttribute)) {
          results[nameAttribute] = childNode;
        } else {
          // Only recurse if the current node doesn't have a name attribute
          // or if the name is already in the results.  This prevents
          // recursion into named nodes.
          traverse(childNode);
        }
      }
    }
  }
  traverse(node);
  // @ts-ignore
  return results;
}

/**
 * Modifies a node to access named descendant elements through added properties of their name.
 * Also adds a property "self" that allows JSDoc annotations of the original node. 
 * You must be careful to use names that do not override existing properties.
 *
 * @param {Element} node The element to modify
 * @returns {Element} The element with with an added "self" property as well as properties
 *          to access named descendants
 */
export function accessNamedDescendentsAsProperties(node) {
  const namedDescendants = findNamedDescendants(node)
  for (let name in namedDescendants) {
    namedDescendants[name] = accessNamedDescendentsAsProperties(namedDescendants[name])
  }
  namedDescendants.self = node
  const modifiedObj = Object.assign(node, namedDescendants)
  return modifiedObj
}

// Function to serialize the XML DOM back to a string (for demonstration)
export function serializeXmlToString(xmlDoc) {
  // Check if xmlDoc is actually a document node before trying to serialize
  if (!xmlDoc || typeof xmlDoc.serializeToString !== 'function') {
    console.error("Invalid document object passed to serializeXmlToString");
    // Attempt to return a string representation if possible, or indicate error
    try {
      if (xmlDoc.documentElement) {
        return new XMLSerializer().serializeToString(xmlDoc.documentElement);
      }
    } catch (e) {
      console.error("Could not serialize even documentElement:", e);
    }
    return "[Invalid XML Document]";
  }
  const serializer = new XMLSerializer();
  return serializer.serializeToString(xmlDoc);
}

/**
 * Tests if an XPath is valid
 * @param {string} xpathExpression 
 * @param {Document} xmlDom The DOM document to test the expression on
 * @param {XPathNSResolver|null} namespaceResolver 
 * @returns {Boolean}
 */
export function isValidXPath(xpathExpression, xmlDom, namespaceResolver = null) {
  try {
    // Check if the XML DOM is valid
    if (!xmlDom || typeof xmlDom !== 'object' || !xmlDom.evaluate) {
      console.error("Invalid XML DOM provided.");
      return false;
    }

    // Try to evaluate the XPath expression
    xmlDom.evaluate(
      xpathExpression,
      xmlDom,
      namespaceResolver,
      XPathResult.ANY_TYPE, // resultType - ANY_TYPE is generally fine for validation
      null     // result - reuse existing result, optional
    );

    return true; // If no error thrown, the XPath is valid

  } catch (error) {
    // An error indicates an invalid XPath expression
    console.error("Invalid XPath:", error.message); // Optionally log the error
    return false;
  }
}
