/**
 * This application plugin implements a dialog registered as the "diaolog" property of the app
 */

import { SlButton, SlDialog, registerTemplate, createSingleFromTemplate, updateUi } from '../ui.js'
import ui from '../ui.js'
import { logger } from '../app.js'

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlInput } from '../ui.js'
 */

// Plugin API
const api = {
  info,
  error,
  success,
  confirm,
  prompt
}

// Plugin object
const plugin = {
  name: "dialog",
  install
}

export { api, plugin }
export default plugin

//
// UI
//

/**
 * Dialog component navigation properties. The dialog element itself serves as both
 * the SlDialog DOM element and the navigation object for its descendants.
 * @typedef {object} dialogPart
 * @property {HTMLSpanElement} message
 * @property {HTMLDivElement} icon
 * @property {SlInput} promptInput
 * @property {SlButton} closeBtn
 * @property {SlButton} cancelBtn
 * @property {SlButton} confirmBtn
 */

//
// implementation
//

// Register template at module level
await registerTemplate('dialog-template', 'dialog.html');

/**
 * Runs when the main app starts so the plugins can register the app components they supply
 * @param {ApplicationState} app The main application
 */
async function install(app) {
  logger.debug(`Installing plugin "${plugin.name}"`)
  createSingleFromTemplate('dialog-template', document.body);
  updateUi();
  ui.dialog.closeBtn.addEventListener('click', () => ui.dialog.hide());
}

/**
 * Shows an informational dialog
 * @param {string} message 
 */
function info(message) {
  ui.dialog.setAttribute("label", "Information");
  ui.dialog.icon.innerHTML = `<sl-icon name="info-circle" style="color: var(--sl-color-primary-500);"></sl-icon>`;
  ui.dialog.message.innerHTML = message
  ui.dialog.show()
}

/**
 * Shows an error dialog
 * @param {string} message 
 */
function error(message) {
  ui.dialog.setAttribute("label", "Error");
  ui.dialog.icon.innerHTML = `<sl-icon name="exclamation-triangle" style="color: var(--sl-color-danger-500);"></sl-icon>`;
  ui.dialog.message.innerHTML = message
  ui.dialog.show()
}

/**
 * Shows a success dialog
 * @param {string} message
 */
function success(message) {
  ui.dialog.setAttribute("label", "Success");
  ui.dialog.icon.innerHTML = `<sl-icon name="check-circle" style="color: var(--sl-color-success-500);"></sl-icon>`;
  ui.dialog.message.innerHTML = message
  ui.dialog.show()
}

/**
 * Shows a confirmation dialog and returns a promise that resolves to true/false
 * @param {string} message - The confirmation message
 * @param {string} [title="Confirm"] - The dialog title
 * @returns {Promise<boolean>} Promise that resolves to true if confirmed, false if cancelled
 */
function confirm(message, title = "Confirm") {
  return new Promise((resolve) => {
    // Set up the dialog
    ui.dialog.setAttribute("label", title);
    ui.dialog.icon.innerHTML = `<sl-icon name="question-circle" style="color: var(--sl-color-warning-500);"></sl-icon>`;
    ui.dialog.message.innerHTML = message;

    // Hide close button, show cancel/confirm buttons
    ui.dialog.closeBtn.style.display = 'none';
    ui.dialog.cancelBtn.style.display = '';
    ui.dialog.confirmBtn.style.display = '';

    // Set up one-time event handlers
    const handleConfirm = () => {
      cleanup();
      ui.dialog.hide();
      resolve(true);
    };

    const handleCancel = () => {
      cleanup();
      ui.dialog.hide();
      resolve(false);
    };

    const handleHide = () => {
      // If dialog is closed without clicking a button, treat as cancel
      cleanup();
      resolve(false);
    };

    const cleanup = () => {
      ui.dialog.confirmBtn.removeEventListener('click', handleConfirm);
      ui.dialog.cancelBtn.removeEventListener('click', handleCancel);
      ui.dialog.removeEventListener('sl-hide', handleHide);
      // Restore normal dialog state
      ui.dialog.closeBtn.style.display = '';
      ui.dialog.cancelBtn.style.display = 'none';
      ui.dialog.confirmBtn.style.display = 'none';
    };

    // Attach event listeners
    ui.dialog.confirmBtn.addEventListener('click', handleConfirm);
    ui.dialog.cancelBtn.addEventListener('click', handleCancel);
    ui.dialog.addEventListener('sl-hide', handleHide, { once: true });

    // Show the dialog
    ui.dialog.show();
  });
}

/**
 * Shows a prompt dialog with an input field and returns a promise that resolves to the entered value or null
 * @param {string} message - The prompt message
 * @param {string} [title="Input"] - The dialog title
 * @param {string} [defaultValue=""] - Default value for the input field
 * @param {string} [placeholder=""] - Placeholder text for the input field
 * @returns {Promise<string|null>} Promise that resolves to the entered value, or null if cancelled
 */
function prompt(message, title = "Input", defaultValue = "", placeholder = "") {
  return new Promise((resolve) => {
    // Set up the dialog
    ui.dialog.setAttribute("label", title);
    ui.dialog.icon.innerHTML = `<sl-icon name="pencil-square" style="color: var(--sl-color-primary-500);"></sl-icon>`;
    ui.dialog.message.innerHTML = message;

    // Show and configure the input field
    ui.dialog.promptInput.style.display = '';
    ui.dialog.promptInput.value = defaultValue;
    ui.dialog.promptInput.placeholder = placeholder;

    // Hide close button, show cancel/confirm buttons
    ui.dialog.closeBtn.style.display = 'none';
    ui.dialog.cancelBtn.style.display = '';
    ui.dialog.confirmBtn.style.display = '';

    // Set up one-time event handlers
    const handleConfirm = () => {
      const value = ui.dialog.promptInput.value.trim();
      ui.dialog.hide();
      // Wait for dialog to actually close before cleaning up and resolving
      ui.dialog.addEventListener('sl-after-hide', () => {
        cleanup();
        resolve(value || null);
      }, { once: true });
    };

    const handleCancel = () => {
      ui.dialog.hide();
      // Wait for dialog to actually close before cleaning up and resolving
      ui.dialog.addEventListener('sl-after-hide', () => {
        cleanup();
        resolve(null);
      }, { once: true });
    };

    const handleHide = () => {
      // If dialog is closed without clicking a button, treat as cancel
      // Wait for dialog to actually close before cleaning up and resolving
      ui.dialog.addEventListener('sl-after-hide', () => {
        cleanup();
        resolve(null);
      }, { once: true });
    };

    const handleEnter = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        handleConfirm();
      }
    };

    const cleanup = () => {
      ui.dialog.confirmBtn.removeEventListener('click', handleConfirm);
      ui.dialog.cancelBtn.removeEventListener('click', handleCancel);
      ui.dialog.removeEventListener('sl-hide', handleHide);
      ui.dialog.promptInput.removeEventListener('keydown', handleEnter);
      // Restore normal dialog state
      ui.dialog.closeBtn.style.display = '';
      ui.dialog.cancelBtn.style.display = 'none';
      ui.dialog.confirmBtn.style.display = 'none';
      ui.dialog.promptInput.style.display = 'none';
      ui.dialog.promptInput.value = '';
    };

    // Attach event listeners
    ui.dialog.confirmBtn.addEventListener('click', handleConfirm);
    ui.dialog.cancelBtn.addEventListener('click', handleCancel);
    ui.dialog.addEventListener('sl-hide', handleHide, { once: true });
    ui.dialog.promptInput.addEventListener('keydown', handleEnter);

    // Show the dialog
    ui.dialog.show();

    // Focus the input field after a short delay to ensure the dialog is visible
    setTimeout(() => {
      ui.dialog.promptInput.focus();
    }, 100);
  });
}
