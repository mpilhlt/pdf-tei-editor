/**
 * User account management plugin - provides user menu with profile editing
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlButton, SlInput, SlMenuItem } from '../ui.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 */

import ui from '../ui.js';
import { registerTemplate, createFromTemplate } from '../modules/ui-system.js';
import Plugin from '../modules/plugin-base.js';
import { logger, client } from '../app.js';
import { notify } from '../modules/sl-utils.js';
import { AuthenticationPlugin } from '../plugins.js';

//
// UI Type Definitions
//

/**
 * @typedef {object} userProfileDialog
 * @property {HTMLFormElement} profileForm
 * @property {SlInput} profileForm.fullnameInput
 * @property {SlInput} profileForm.emailInput
 * @property {SlInput} profileForm.passwordInput
 * @property {SlInput} profileForm.repeatPasswordInput
 * @property {HTMLDivElement} profileForm.errorMessage
 * @property {SlButton} cancelBtn
 * @property {SlButton} saveBtn
 */

// Register templates
await registerTemplate('user-profile-dialog', 'user-profile-dialog.html');
await registerTemplate('user-menu-items', 'user-menu-items.html');

//
// User Account Plugin Class
//

class UserAccountPlugin extends Plugin {
  /**
   * @param {PluginContext} context
   */
  constructor(context) {
    super(context, {
      name: 'user-account',
      deps: ['client', 'authentication', 'toolbar']
    });
  }

  /**
   * Plugin installation - creates UI and sets up event handlers
   * @param {ApplicationState} initialState
   */
  async install(initialState) {
    await super.install(initialState);
    logger.debug(`Installing plugin "${this.name}"`);

    // Create UI elements
    createFromTemplate('user-profile-dialog', document.body);

    // Prevent dialog from closing on outside click
    ui.userProfileDialog.addEventListener('sl-request-close', (event) => {
      if (event.detail.source === 'overlay') {
        event.preventDefault();
      }
    });

    // Setup form event handlers
    this._setupFormHandlers();

    // Add menu items to the toolbar menu (which was created by toolbar plugin)
    createFromTemplate('user-menu-items', ui.toolbar.toolbarMenu.menu);

    logger.debug('User account menu items added to toolbar menu');

    // Setup menu item handlers
    ui.toolbar.toolbarMenu.menu.profileMenuItem.addEventListener('click', () => {
      this.showProfileDialog();
    });

    ui.toolbar.toolbarMenu.menu.logoutMenuItem.addEventListener('click', () => {
      this.logout();
    });
  }

  async start() {
    // No longer needed - menu items are added during install phase
    logger.debug(`Starting plugin "${this.name}"`);
  }

  /**
   * React to state changes
   * @param {string[]} changedKeys
   */
  async onStateUpdate(changedKeys) {
    if (changedKeys.includes('user')) {
      const user = this.state?.user;
      ui.toolbar.toolbarMenu.menuBtn.disabled = user === null;
    }
  }

  /**
   * Public API methods
   */

  /**
   * Shows the user profile dialog
   */
  async showProfileDialog() {
    const user = this.state?.user;
    if (!user) {
      logger.error('No user logged in');
      return;
    }

    // Populate form with current user data
    ui.userProfileDialog.profileForm.fullnameInput.value = user.fullname || '';
    ui.userProfileDialog.profileForm.emailInput.value = user.email || '';
    ui.userProfileDialog.profileForm.passwordInput.value = '';
    ui.userProfileDialog.profileForm.repeatPasswordInput.value = '';
    ui.userProfileDialog.profileForm.errorMessage.style.display = 'none';

    ui.userProfileDialog.show();
  }

  /**
   * Logs the user out by delegating to the authentication plugin
   */
  async logout() {
    const authPlugin = AuthenticationPlugin.getInstance();
    await authPlugin.logout();
  }

  /**
   * Private methods
   */

  /**
   * Setup form event handlers
   * @private
   */
  _setupFormHandlers() {
    // Cancel button
    ui.userProfileDialog.cancelBtn.addEventListener('click', () => {
      ui.userProfileDialog.hide();
    });

    // Save button
    ui.userProfileDialog.saveBtn.addEventListener('click', async () => {
      await this._saveProfile();
    });

    // Allow Enter key to submit
    ui.userProfileDialog.profileForm.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this._saveProfile();
      }
    });
  }

  /**
   * Save profile changes
   * @private
   */
  async _saveProfile() {
    const fullname = ui.userProfileDialog.profileForm.fullnameInput.value.trim();
    const email = ui.userProfileDialog.profileForm.emailInput.value.trim();
    const password = ui.userProfileDialog.profileForm.passwordInput.value;
    const repeatPassword = ui.userProfileDialog.profileForm.repeatPasswordInput.value;

    // Validate passwords match if provided
    if (password || repeatPassword) {
      if (password !== repeatPassword) {
        ui.userProfileDialog.profileForm.errorMessage.textContent = 'Passwords do not match';
        ui.userProfileDialog.profileForm.errorMessage.style.display = 'block';
        return;
      }
      if (password.length < 6) {
        ui.userProfileDialog.profileForm.errorMessage.textContent = 'Password must be at least 6 characters';
        ui.userProfileDialog.profileForm.errorMessage.style.display = 'block';
        return;
      }
    }

    // Hide error message
    ui.userProfileDialog.profileForm.errorMessage.style.display = 'none';

    // Prepare update request
    const updateData = {
      fullname,
      email
    };

    // Add password hash if password was provided
    if (password) {
      updateData.passwd_hash = await this._hashPassword(password);
    }

    try {
      // Call API to update profile
      const updatedUser = await client.apiClient.usersMeProfile(updateData);

      // Update state with new user data
      await this.dispatchStateChange({
        user: {
          username: updatedUser.username,
          fullname: updatedUser.fullname,
          email: updatedUser.email,
          roles: updatedUser.roles
        }
      });

      // Show success notification
      notify('Profile updated successfully', 'success', 'check-circle');

      // Close dialog
      ui.userProfileDialog.hide();

      logger.info('User profile updated successfully');
    } catch (error) {
      logger.error('Error updating profile: ' + String(error));
      ui.userProfileDialog.profileForm.errorMessage.textContent = 'Failed to update profile: ' + String(error);
      ui.userProfileDialog.profileForm.errorMessage.style.display = 'block';
    }
  }

  /**
   * Hashes a password using SHA-256.
   * @param {string} password
   * @returns {Promise<string>}
   * @private
   */
  async _hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

//
// Exports
//

export default UserAccountPlugin;
