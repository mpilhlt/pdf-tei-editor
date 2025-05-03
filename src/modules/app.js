import EventEmitter from 'eventemitter3';
import plugin from "./plugin.js"

/**
 * App class that manages the application state, services, plugins and event bus.
 * All components of the class should be implemented as plugins, using the js-plugin libraryn
 * (@see https://www.npmjs.com/package/js-plugin)
 * 
 * @property {plugin} plugin - The plugin manager for the application.
 */
export class App {

  /**
   * Event bus for communication between components
   * @type {EventEmitter}
   */
  #bus; 

  /**
   * Key-Value store of objects that are compoents of the app, including, but not limited to 
   * DOM elements. Components are registered by plugins with the registerComponent method and are 
   * read-only properties of the app. Components provide the functionality of the app
   * @type {Object}
   */
  #components;

  /**
   * Key-value store of named application states. States are registered with the registerState 
   * method and are writable properties of the app. They can be associated with URL hash parameters
   * and emit events when they change.
   * @type {Object}
   */
  #state;

  /**
   * Key-value store of params in the URL hash that are associated with application states.
   * @type {Object}
   */
  #urlHashParams = {}

  /**
   * The plugin manager for the application. This is a reference to the js-plugin library.
   */
  plugin;

  constructor() {
    this.#bus = new EventEmitter();
    this.#components = {};
    this.#state = {};
    this.plugin = plugin;

    // Initialize state
    window.addEventListener('load', () => {
      this.updateFromUrlHash();
    });

    // Update properties when the URL hash changes
    window.addEventListener('hashchange', () => {
      this.updateFromUrlHash();
    });
  }

  /**
   * Updates the properties from the URL hash.
   */
  updateFromUrlHash() {
    const urlParams = new URLSearchParams(window.location.hash.slice(1));
    for (const [key, value] of urlParams.entries()) {
      if (this.#urlHashParams[key] !== undefined) {
        const stateName = this.#urlHashParams[key];
        // Update the property value using the setter
        this.#state[stateName] = value;
      }
    }
  }

  /**
   * Registers an application component. This can be a UI element or any arbitrary object that "does things"
   * @param {string} name The name of the component to register
   * @param {Object} component The component to register 
   * @param {string?} property If given, the component will be registered as a property of the app with this name
   * @throws {Error} If the component or property already exists
   */
  registerComponent(name, component, property) {
    if (this.#components[name] !== undefined) {
      throw new Error(`Component "${name}" already registered.`);
    }
    if (this[name] !== undefined) {
      throw new Error(`Will not overwrite existing property "${name}".`);
    }

    this.#components[name] = component;
    
    Object.defineProperty(this, property, {
      get: () => this.#components[name],
      set: (value) => {
        throw new Error(`Property "${name}" is read-only.`);
      }
    })
  }

  /**
   * Returns the component with the given name.
   * @param {string} name Name of the component
   * @returns {Object} 
   * @throws {Error} If the component does not exist
   */
  getComponent(name) {
    if (this.#components[name] === undefined) {
      throw new Error(`Component "${name}" not found.`);
    }
    return this.#components[name];
  }

  /**
   * Returns the list of registered components.
   * @returns {Array} 
   */
  getComponents() {
    return this.#components;
  }
  
  /**
   * Registers an application state, optionally with a bound URL hash paramenter and/or a property of the app 
   * with a getter and setter. When the state changes, an event is emitted with the name 'change:{name}' and the
   * new and old values. The event name can be overridden by passing a different name, and can be disabled by passing null.
   * 
   * @param {string} name The nmne of the property to register
   * @param {any?} initialValue If an initial value should be set (without emitting an event) 
   * @param {string?} property The URL hash parameter to use for this property, if any
   * @param {string?} urlHashParam The URL hash parameter to use for this property, if any
   * @param {string?} eventName The name of the event to dispatch when the property changes, defaults to 'change:{name}'. 
   * Pass null to disable event emitting.
   * @throws {Error} If the property already exists
   * @returns {void}
   */
  registerState(name, initialValue, property, urlHashParam, eventName) {
    if (!name) {
      throw new Error('Name is required');
    }
    if (this.#state[name] !== undefined) {
      throw new Error(`State ${name} already exists`);
    }

    // set initial value without triggering the setter
    if (initialValue !== undefined) {
      this.#state[name] = initialValue
    }

    // event name is optional
    if (eventName === undefined) {
      eventName = `change:${name}`;
    }

    // register a property with a getter and setter
    if (property) {
      if (this[property] !== undefined) {
        throw new Error(`Property ${property} already exists`);
      }
      
      Object.defineProperty(this, name, {
        get: () => this.#state[name],
        set: (value) => {
          // do nothing if the value is the same
          if (this.#state[name] === value) {
            return;
          }

          // If a URL hash parameter has been registered, update the URL hash
          if (urlHashParam) {
            const url = new URL(window.location.href);
            const urlHashParams = new URLSearchParams(window.location.hash.slice(1));
            urlHashParams.set(urlHashParam, value);
            url.hash = `#${urlHashParams.toString()}`;
            //window.history.replaceState({}, '', url);
            window.history.pushState({}, '', url);
          }

          // unless the event name is null, dispatch a custom event to notify listeners of the change
          if (eventName) {
            this.#bus.emit(eventName, value, this.#state[name]);
          }

          // Update the state value
          this.#state[name] = value;
        }
      });
    }

    // mark the property as connected with an url hash parameter if provided
    if (urlHashParam !== undefined) {
      this.#urlHashParams[urlHashParam] = name;
    }

  }

  async start() {
    this.#bus.emit('app:starting');
    this.plugin.invoke('app.start', this)
    this.#bus.emit('app:plugins-installed');
  }

  async stop() {
    this.#bus.emit('app:stopping');
    this.plugin.invoke('app.stop', this)
  }


  emit(event, ...args) {
    this.#bus.emit(event, ...args);
  }

  on(event, listener, context) {
    this.#bus.on(event, listener, context);
  }

  once(event, listener, context) {
    this.#bus.once(event, listener, context);
  }

  off(event, listener, context) {
    this.#bus.off(event, listener, context);
  }

}

