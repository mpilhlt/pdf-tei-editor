/**
 * Base class for managing application state.
 * It provides methods to register properties with getters and setters,
 * and to update properties from the URL hash.
 * It also dispatches a custom event when a property changes.
 */
class ApplicationStateBase {

  #properties = {}
  #urlHashParams = {}

  constructor() {
    // Initialize properties
    window.addEventListener('load', () => {
      this.updateFromUrlHash();
    });

    // Update properties when the URL hash changes
    window.addEventListener('hashchange', () => {
      this.updateFromUrlHash();
    });
  }

  /**
   * Registers a property with a getter and setter.
   * The setter updates the property value and, if a URL hash parameter is provided,
   * it updates the URL hash with the new value.
   * @param {string} name The nmne of the property to register
   * @param {string?} urlHashParam The URL hash parameter to use for this property, if any
   * @param {string?} eventName The name of the event to dispatch when the property changes
   * @param {any?} initialValue If an initial value should be set (without triggering the setter logic)
   * @throws {Error} If the property already exists
   * @returns {void}
   */
  register(name, urlHashParam, eventName, initialValue) {
    if (this.#properties[name] !== undefined) {
      throw new Error(`Property ${name} already exists`);
    }
    Object.defineProperty(this, name, {
      get: () => this.#properties[name],
      set: (value) => {
        // do nothing if the value is the same
        if (this.#properties[name] === value) {
          return;
        }

        // If a URL hash parameter has been registered, update the URL hash
        if (urlHashParam) {
          const url = new URL(window.location.href);
          url.hash = `#${urlHashParam}=${value}`;
          window.history.pushState({}, '', url);
        }

        if (eventName) {
          // Dispatch a custom event to notify listeners of the change
          const event = new CustomEvent(eventName, {
            detail: { property: name, value: value, old: this.#properties[name] },
          });
          this.dispatchEvent(event);
        }
        
        // Update the property value
        this.#properties[name] = value;
      }
    });

    // mark the property as connected with an url hash parameter if provided
    if (urlHashParam !== undefined) {
      this.#urlHashParams[urlHashParam] = name;
    }

    // set initial value without triggering the setter
    if (initialValue !== undefined) {
      this.#properties[name] = initialValue
    }
  }

  /**
   * Updates the properties from the URL hash.
   */
  updateFromUrlHash() {
    const urlParams = new URLSearchParams(window.location.hash.slice(1));
    for (const [key, value] of urlParams.entries()) {
      if (this.#urlHashParams[key] !== undefined) {
        const propertyName = this.#urlHashParams[key];
        // Update the property value using the setter
        this[propertyName] = value;
      }
    }
  }

}


/**
 * @module ApplicationState
 * @description This module contains the ApplicationState class, which manages the state of the application.
 * @property {Array<Object>} fileData - The data on the files on the server which can be worked on
 * @property {string} pdfPath - The path to the PDF file
 * @property {string} xmlPath - The path to the XML file  
 * @property {string} diffXmlPath - The path to the diff XML file
 * @property {Object} pdfViewer - The PDF viewer object
 * @property {Object} xmlEditor - The XML editor object
 * @property {Object} lastSelectedXpathlNode - The last selected XPath node
 * @property {number} currentIndex - The current index of the selected node
 * @property {string} selectionXpath - The XPath of the selected node
 * @property {string} lastCursorXpath - The XPath of the last cursor position
 * @property {number} currentXpathResultSize - The size of the current XPath result
 * @property {number} currentXpathResultIndex - The index of the current XPath result
 * @property {Object} lastSelectedXpathlNode - The last selected XPath node
 */
export class ApplicationState extends ApplicationStateBase {

  constructor() {
    // Register properties with their corresponding URL hash parameters    
    this.register('pdfPath', 'pdf');
    this.register('xmlPath', 'xml');
    this.register('diffXmlPath', 'diff');
    this.register('selectionXpath', 'xpath');

    // non- urlHashParam properties
    this.register('pdfViewer');
    this.register('xmlEditor');
    this.register('fileData');
    this.register('lastSelectedXpathlNode');
    this.register('currentIndex');
    this.register('lastCursorXpath');
    this.register('currentXpathResultSize');
    this.register('currentXpathResultIndex');

    super();
  }
}

/**
 * Base class for managing UI state.
 * It provides methods to register elements identified by its setter as properties of the class with getters and setters
 */
export class UiState extends EventTarget {

  #properties = {}
  #loadDataMap = new WeakMap()

  /**
   * Registers a HTML element identified by its selector as a read-only property of the class
   * @param {string} name The name of the property to register
   * @param {string} selector The selector for the element to register under this property
   * @param {Function?} loadFn An optional async function that is used to populate complex elements such a selectbox
   * @param {string?} labelKey The key to use for the "text" value of the options in case of a selectbox
   * @param {string?} valueKey The key to use for the "value" value of the options in case of a selectbox
   * @throws {Error} If the property already exists or the element is not found
   * @returns {HTMLElement} The element registered under this property
   */
  register(name, selector, loadFn, labelKey="label", valueKey="value") {
    if (this.#properties[name] !== undefined) {
      throw new Error(`Property ${name} already exists`);
    }
    const element = document.querySelector(selector);
    if (!element) {
      throw new Error(`Element ${selector} not found`);
    }
    this.#properties[name] = {element, selector, loadFn}
    Object.defineProperty(this, name, {
      get: () => this.#properties[name].element,
      set: (value) => {
        throw new Error(`Property ${name} is read-only.`);
      }
    })
    if (loadFn) {
      this.#loadDataMap.set(element, {loadFn, labelKey, valueKey})
    }
    return element
  }

  /**
   * Populates the given selectbox with data
   * @param {HTMLSelectElement} element The select box
   * @param {Array<Object>} data The data to populate the selectbox with 
   * @param {string} labelKey The key to use for the "text" value of the option
   * @param {string} valueKey The key to use for the "value" value of the option
   */
  populate(element, data, labelKey="label", valueKey="value") {
    if (!(element instanceof HTMLSelectElement )) {
      throw new Error("Can only populate HTMLSelectElement elements")
    }
    if (!Array.isArray(data) || !data.every(item => item[labelKey] !== undefined && item[valueKey] !== undefined)) {
      throw new Error(`Options data is not in the form of [{${labelKey}, ${valueKey}}, ...]`)
    }
    // remember the current value to re-set it afterwards
    const oldValue = element.value
    // remove all children
    element.innerHTML = ''
    // add options
    data.forEach(item => {
      const option = document.createElement('option');
      Object.assign(option, { text: item[labelKey], value: item[valueKey]})
      Object.assign(option.dataset, item)
      if (option.value === oldValue) {
        option.selected = true
      }
      element.appendChild(option)
    })
  }


  /**
   * Reload the given element by calling the registered function 
   * @param {HTMLSelectElement} element 
   * @returns 
   */
  async reload(element) {
    const elemInfo = this.#loadDataMap.get(element)
    if (!elemInfo) {
      throw new Error("No load function registered for this element")
    }
    const {loadFn, labelKey, valueKey} = elemInfo
    const data = await loadFn(element)
    this.populate(element, data, labelKey, valueKey)
    return element
  }

}

/**
 * This singleton instance manages the UI state of the application.
 * @property {HTMLSelectElement} selectDocument
 * @property {HTMLSelectElement} selectVersion
 * @property {HTMLSelectElement} selectDiff
 */
const ui = new class extends UiState {
  constructor() {
    super();
    this.register('selectDocument', '#select-doc', client.getFileList, );
    this.register('selectVersion', '#select-version');
    this.register('selectDiff', '#select-diff-version');
  }
}