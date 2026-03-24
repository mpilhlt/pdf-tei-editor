/**
 * Dialog plugin providing modal dialogs for info, error, success, confirm, and prompt.
 */

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { SlDialog } from '../ui.js'
 * @import { dialogPart } from '../templates/dialog.types.js'
 */

import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js';
import Plugin from '../modules/plugin-base.js';

/**
 * @typedef {Object} dialogApi
 * @property {(message:string) => void} info
 * @property {(message:string) => void} error
 * @property {(message:string) => void} success
 * @property {(message:string, title?:string) => Promise<boolean>} confirm
 * @property {(message:string, title?:string, defaultValue?:string, placeholder?:string) => Promise<string|null>} prompt
 */

// Register template at module level
await registerTemplate('dialog-template', 'dialog.html');

class DialogPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, {
      name: 'dialog',
      deps: []
    });
  }

  /** @type {SlDialog & dialogPart} */
  #ui = null

  async install(state) {
    await super.install(state);
    this.getDependency('logger').debug(`Installing plugin "${this.name}"`);
    this.#ui = this.createUi(createSingleFromTemplate('dialog-template', document.body))
    this.#ui.closeBtn.addEventListener('click', () => this.#ui.hide());
  }

  /**
   * @param {string} message
   */
  info(message) {
    this.#ui.setAttribute('label', 'Information');
    this.#ui.icon.innerHTML = `<sl-icon name="info-circle" style="color: var(--sl-color-primary-500);"></sl-icon>`;
    this.#ui.message.innerHTML = message;
    this.#ui.show();
  }

  /**
   * @param {string} message
   */
  error(message) {
    this.#ui.setAttribute('label', 'Error');
    this.#ui.icon.innerHTML = `<sl-icon name="exclamation-triangle" style="color: var(--sl-color-danger-500);"></sl-icon>`;
    this.#ui.message.innerHTML = message;
    this.#ui.show();
  }

  /**
   * @param {string} message
   */
  success(message) {
    this.#ui.setAttribute('label', 'Success');
    this.#ui.icon.innerHTML = `<sl-icon name="check-circle" style="color: var(--sl-color-success-500);"></sl-icon>`;
    this.#ui.message.innerHTML = message;
    this.#ui.show();
  }

  /**
   * @param {string} message
   * @param {string} [title="Confirm"]
   * @returns {Promise<boolean>}
   */
  confirm(message, title = 'Confirm') {
    return new Promise((resolve) => {
      this.#ui.setAttribute('label', title);
      this.#ui.icon.innerHTML = `<sl-icon name="question-circle" style="color: var(--sl-color-warning-500);"></sl-icon>`;
      this.#ui.message.innerHTML = message;

      this.#ui.closeBtn.style.display = 'none';
      this.#ui.cancelBtn.style.display = '';
      this.#ui.confirmBtn.style.display = '';

      const handleConfirm = () => { cleanup(); this.#ui.hide(); resolve(true); };
      const handleCancel = () => { cleanup(); this.#ui.hide(); resolve(false); };
      const handleHide = () => { cleanup(); resolve(false); };

      const cleanup = () => {
        this.#ui.confirmBtn.removeEventListener('click', handleConfirm);
        this.#ui.cancelBtn.removeEventListener('click', handleCancel);
        this.#ui.removeEventListener('sl-hide', handleHide);
        this.#ui.closeBtn.style.display = '';
        this.#ui.cancelBtn.style.display = 'none';
        this.#ui.confirmBtn.style.display = 'none';
      };

      this.#ui.confirmBtn.addEventListener('click', handleConfirm);
      this.#ui.cancelBtn.addEventListener('click', handleCancel);
      this.#ui.addEventListener('sl-hide', handleHide, { once: true });
      this.#ui.show();
    });
  }

  /**
   * @param {string} message
   * @param {string} [title="Input"]
   * @param {string} [defaultValue=""]
   * @param {string} [placeholder=""]
   * @returns {Promise<string|null>}
   */
  prompt(message, title = 'Input', defaultValue = '', placeholder = '') {
    return new Promise((resolve) => {
      this.#ui.setAttribute('label', title);
      this.#ui.icon.innerHTML = `<sl-icon name="pencil-square" style="color: var(--sl-color-primary-500);"></sl-icon>`;
      this.#ui.message.innerHTML = message;

      this.#ui.promptInput.style.display = '';
      this.#ui.promptInput.value = defaultValue;
      this.#ui.promptInput.placeholder = placeholder;

      this.#ui.closeBtn.style.display = 'none';
      this.#ui.cancelBtn.style.display = '';
      this.#ui.confirmBtn.style.display = '';

      const handleConfirm = () => {
        const value = this.#ui.promptInput.value.trim();
        this.#ui.hide();
        this.#ui.addEventListener('sl-after-hide', () => { cleanup(); resolve(value || null); }, { once: true });
      };
      const handleCancel = () => {
        this.#ui.hide();
        this.#ui.addEventListener('sl-after-hide', () => { cleanup(); resolve(null); }, { once: true });
      };
      const handleHide = () => {
        this.#ui.addEventListener('sl-after-hide', () => { cleanup(); resolve(null); }, { once: true });
      };
      const handleEnter = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleConfirm(); }
      };

      const cleanup = () => {
        this.#ui.confirmBtn.removeEventListener('click', handleConfirm);
        this.#ui.cancelBtn.removeEventListener('click', handleCancel);
        this.#ui.removeEventListener('sl-hide', handleHide);
        this.#ui.promptInput.removeEventListener('keydown', handleEnter);
        this.#ui.closeBtn.style.display = '';
        this.#ui.cancelBtn.style.display = 'none';
        this.#ui.confirmBtn.style.display = 'none';
        this.#ui.promptInput.style.display = 'none';
        this.#ui.promptInput.value = '';
      };

      this.#ui.confirmBtn.addEventListener('click', handleConfirm);
      this.#ui.cancelBtn.addEventListener('click', handleCancel);
      this.#ui.addEventListener('sl-hide', handleHide, { once: true });
      this.#ui.promptInput.addEventListener('keydown', handleEnter);
      this.#ui.show();
      setTimeout(() => this.#ui.promptInput.focus(), 100);
    });
  }
}

export default DialogPlugin;

/**
 * Lazy-proxy API for backward compatibility.
 * @deprecated Use `getDependency('dialog')` in plugins, or import `DialogPlugin` directly.
 */
export const api = new Proxy({}, {
  get(_, prop) {
    const instance = DialogPlugin.getInstance()
    const value = instance[prop]
    return typeof value === 'function' ? value.bind(instance) : value
  },
  set(_, prop, value) {
    DialogPlugin.getInstance()[prop] = value
    return true
  }
});

/** @deprecated Use DialogPlugin class directly */
export const plugin = DialogPlugin;
