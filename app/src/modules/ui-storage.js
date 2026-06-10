/**
 * UIStorage — persistent key-value store for UI preferences.
 *
 * Wraps localStorage with a namespaced key scheme and optional DOM binding.
 * Use from plugins via `this.uiStorage` (provided by Plugin base class).
 */
export class UIStorage {
  /**
   * @param {string} namespace - Plugin or feature name (e.g. 'xmleditor', 'layout')
   * @param {Storage} [storage] - Storage backend; defaults to localStorage. Injectable for testing.
   */
  constructor(namespace, storage = localStorage) {
    this._namespace = namespace;
    this._storage = storage;
  }

  /**
   * @param {string} key
   * @returns {string}
   */
  _key(key) {
    return `ui.${this._namespace}.${key}`;
  }

  /**
   * Read a persisted value.
   * @param {string} key
   * @param {*} [defaultValue] - Returned when the key is absent.
   * @returns {*}
   */
  get(key, defaultValue = undefined) {
    const raw = this._storage.getItem(this._key(key));
    if (raw === null) return defaultValue;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  /**
   * Persist a value. Values are JSON-serialized.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    this._storage.setItem(this._key(key), JSON.stringify(value));
  }

  /**
   * Remove a persisted value.
   * @param {string} key
   */
  remove(key) {
    this._storage.removeItem(this._key(key));
  }

  /**
   * Bind an element property to a persisted key.
   *
   * On call: restores the stored value (or `default`) to `element[property]`.
   * On `event`: saves the current `element[property]` to storage.
   *
   * @param {EventTarget & Record<string, any>} element - DOM element to bind
   * @param {string} property - Element property name (e.g. 'position', 'checked')
   * @param {object} options
   * @param {string} options.key - Storage key within this namespace
   * @param {string} options.event - DOM event that signals a value change (e.g. 'sl-reposition')
   * @param {*} [options.default] - Value to use when nothing is stored yet
   * @returns {() => void} Unbind function — call to remove the event listener
   */
  bind(element, property, { key, event, default: defaultValue } = {}) {
    if (!element) throw new Error('UIStorage.bind(): element is null or undefined');
    if (!key) throw new Error('UIStorage.bind(): options.key is required');
    if (!event) throw new Error('UIStorage.bind(): options.event is required');
    const stored = this.get(key, defaultValue);
    if (stored !== undefined) element[property] = stored;
    const handler = () => this.set(key, element[property]);
    element.addEventListener(event, handler);
    return () => element.removeEventListener(event, handler);
  }
}
