/**
 * Dialog plugin providing modal dialogs for info, error, success, confirm, and prompt.
 */

import { registerTemplate, createSingleFromTemplate, updateUi } from '../ui.js';
import ui from '../ui.js';
import Plugin from '../modules/plugin-base.js';

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { SlInput } from '../ui.js'
 */

/**
 * @typedef {Object} dialogApi
 * @property {(message:string) => void} info
 * @property {(message:string) => void} error
 * @property {(message:string) => void} success
 * @property {(message:string, title?:string) => Promise<boolean>} confirm
 * @property {(message:string, title?:string, defaultValue?:string, placeholder?:string) => Promise<string|null>} prompt
 */

/**
 * Dialog component navigation properties.
 * @typedef {object} dialogPart
 * @property {HTMLSpanElement} message
 * @property {HTMLDivElement} icon
 * @property {SlInput} promptInput
 * @property {import('../ui.js').SlButton} closeBtn
 * @property {import('../ui.js').SlButton} cancelBtn
 * @property {import('../ui.js').SlButton} confirmBtn
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

  async install(state) {
    await super.install(state);
    this.getDependency('logger').debug(`Installing plugin "${this.name}"`);
    createSingleFromTemplate('dialog-template', document.body);
    updateUi();
    ui.dialog.closeBtn.addEventListener('click', () => ui.dialog.hide());
  }
}

export default DialogPlugin;

/** Lazy-proxy API for backward compatibility */
export const api = {
  info,
  error,
  success,
  confirm,
  prompt
};

/** @deprecated Use DialogPlugin class directly */
export const plugin = DialogPlugin;

//
// API implementation (module-level, uses ui.dialog)
//

/**
 * @param {string} message
 */
function info(message) {
  ui.dialog.setAttribute('label', 'Information');
  ui.dialog.icon.innerHTML = `<sl-icon name="info-circle" style="color: var(--sl-color-primary-500);"></sl-icon>`;
  ui.dialog.message.innerHTML = message;
  ui.dialog.show();
}

/**
 * @param {string} message
 */
function error(message) {
  ui.dialog.setAttribute('label', 'Error');
  ui.dialog.icon.innerHTML = `<sl-icon name="exclamation-triangle" style="color: var(--sl-color-danger-500);"></sl-icon>`;
  ui.dialog.message.innerHTML = message;
  ui.dialog.show();
}

/**
 * @param {string} message
 */
function success(message) {
  ui.dialog.setAttribute('label', 'Success');
  ui.dialog.icon.innerHTML = `<sl-icon name="check-circle" style="color: var(--sl-color-success-500);"></sl-icon>`;
  ui.dialog.message.innerHTML = message;
  ui.dialog.show();
}

/**
 * @param {string} message
 * @param {string} [title="Confirm"]
 * @returns {Promise<boolean>}
 */
function confirm(message, title = 'Confirm') {
  return new Promise((resolve) => {
    ui.dialog.setAttribute('label', title);
    ui.dialog.icon.innerHTML = `<sl-icon name="question-circle" style="color: var(--sl-color-warning-500);"></sl-icon>`;
    ui.dialog.message.innerHTML = message;

    ui.dialog.closeBtn.style.display = 'none';
    ui.dialog.cancelBtn.style.display = '';
    ui.dialog.confirmBtn.style.display = '';

    const handleConfirm = () => { cleanup(); ui.dialog.hide(); resolve(true); };
    const handleCancel = () => { cleanup(); ui.dialog.hide(); resolve(false); };
    const handleHide = () => { cleanup(); resolve(false); };

    const cleanup = () => {
      ui.dialog.confirmBtn.removeEventListener('click', handleConfirm);
      ui.dialog.cancelBtn.removeEventListener('click', handleCancel);
      ui.dialog.removeEventListener('sl-hide', handleHide);
      ui.dialog.closeBtn.style.display = '';
      ui.dialog.cancelBtn.style.display = 'none';
      ui.dialog.confirmBtn.style.display = 'none';
    };

    ui.dialog.confirmBtn.addEventListener('click', handleConfirm);
    ui.dialog.cancelBtn.addEventListener('click', handleCancel);
    ui.dialog.addEventListener('sl-hide', handleHide, { once: true });
    ui.dialog.show();
  });
}

/**
 * @param {string} message
 * @param {string} [title="Input"]
 * @param {string} [defaultValue=""]
 * @param {string} [placeholder=""]
 * @returns {Promise<string|null>}
 */
function prompt(message, title = 'Input', defaultValue = '', placeholder = '') {
  return new Promise((resolve) => {
    ui.dialog.setAttribute('label', title);
    ui.dialog.icon.innerHTML = `<sl-icon name="pencil-square" style="color: var(--sl-color-primary-500);"></sl-icon>`;
    ui.dialog.message.innerHTML = message;

    ui.dialog.promptInput.style.display = '';
    ui.dialog.promptInput.value = defaultValue;
    ui.dialog.promptInput.placeholder = placeholder;

    ui.dialog.closeBtn.style.display = 'none';
    ui.dialog.cancelBtn.style.display = '';
    ui.dialog.confirmBtn.style.display = '';

    const handleConfirm = () => {
      const value = ui.dialog.promptInput.value.trim();
      ui.dialog.hide();
      ui.dialog.addEventListener('sl-after-hide', () => { cleanup(); resolve(value || null); }, { once: true });
    };
    const handleCancel = () => {
      ui.dialog.hide();
      ui.dialog.addEventListener('sl-after-hide', () => { cleanup(); resolve(null); }, { once: true });
    };
    const handleHide = () => {
      ui.dialog.addEventListener('sl-after-hide', () => { cleanup(); resolve(null); }, { once: true });
    };
    const handleEnter = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); handleConfirm(); }
    };

    const cleanup = () => {
      ui.dialog.confirmBtn.removeEventListener('click', handleConfirm);
      ui.dialog.cancelBtn.removeEventListener('click', handleCancel);
      ui.dialog.removeEventListener('sl-hide', handleHide);
      ui.dialog.promptInput.removeEventListener('keydown', handleEnter);
      ui.dialog.closeBtn.style.display = '';
      ui.dialog.cancelBtn.style.display = 'none';
      ui.dialog.confirmBtn.style.display = 'none';
      ui.dialog.promptInput.style.display = 'none';
      ui.dialog.promptInput.value = '';
    };

    ui.dialog.confirmBtn.addEventListener('click', handleConfirm);
    ui.dialog.cancelBtn.addEventListener('click', handleCancel);
    ui.dialog.addEventListener('sl-hide', handleHide, { once: true });
    ui.dialog.promptInput.addEventListener('keydown', handleEnter);
    ui.dialog.show();
    setTimeout(() => ui.dialog.promptInput.focus(), 100);
  });
}
