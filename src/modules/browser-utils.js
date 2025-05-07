
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
  Object.assign(node, {
    hide: node.hide === undefined ? () => {node.style.visibility = "hidden"} : node.hide,
    show: node.show === undefined ? () => {node.style.visibility = "visible"} : node.show,
    text: node.text === undefined ? (text) => {node.textContent = text; return node} : node.text,
    html: node.html === undefined ? (html) => {node.innerHTML = html; return node} : node.html,
    remove: node.remove === undefined ? () => {node.parentNode.removeChild(node)} : node.remove,
    addClass: node.addClass === undefined ? (className) => {node.classList.add(className)} : node.addClass,
    removeClass: node.removeClass === undefined ? (className) => {node.classList.remove(className)} : node.removeClass,
    toggleClass: node.toggleClass === undefined ? (className) => {node.classList.toggle(className)} : node.toggleClass,
    on: node.on === undefined ? (event, callback) => {node.addEventListener(event, callback)} : node.on,
    off: node.off === undefined ? (event, callback) => {node.removeEventListener(event, callback)} : node.off,
    once: node.once === undefined ? (event, callback) => {node.addEventListener(event, callback, { once: true })} : node.once,
    enable: node.disabled !== undefined ? () => { node.disabled = false } : undefined,
    disable: node.disabled !== undefined ? () => { node.disabled = true } : undefined,
    click: handler => node.addEventListener('click', handler.bind(node))
  })

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
   * Returns true if the key exists in the cookies or false if not
   * @param {string} key The key of the hash parameter to retrieve.
   * @returns {boolean}
   */
  static has(key) {
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
 * Creates and returns a random id that can be used for uniquely identifying a DOM node
 * @returns {string}
 */
export function createRandomId() {
  return "id-" + Math.random()*100
}

/**
 * Parses the HTML and attaches it to a parent node (defaults to document.body), optionally assigning 
 * a given or random id if the content is a single node. Returns the created elements. 
 * @param {string} html The html that will be parsed and appended
 * @param {Element?} parentNode The DOM parent element the parsed content will be added to. If not provided, the 
 * content will be added to document.body 
 * @param {string?} id The ID of the parsed content. If none is specified, a random ID will be assigned. 
 * The ID will only be applied if the html consists of a single top node.
 * @returns {Array<Element>} An array of elements that have been created and attached to the DOM 
 */
export function appendHtml(html, parentNode = document.body, id) {
  const div = document.createElement("div")
  div.innerHTML = html.trim()
  div.childNodes.forEach(node => parentNode.appendChild(node))
  if (id && div.childElementCount > 1) {
    throw new Error("ID cannot be assigned to multi-node content")
  }
  if (div.childElementCount === 1) {
    if (id) {
      parentNode.firstChild.id = id
    } else {
      parentNode.firstChild.id = createRandomId()
    }
  }
  return Array.from(parentNode.childNodes)
}
