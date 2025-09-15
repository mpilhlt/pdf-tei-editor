/**
 * Authentication plugin using the new class-based architecture
 */

/** 
 * @import { ApplicationState } from '../state.js' 
 * @import { SlButton, SlInput } from '../ui.js'
 */

import ui, { updateUi } from '../ui.js';
import { registerTemplate, createFromTemplate, createSingleFromTemplate } from '../modules/ui-system.js';
import Plugin from '../modules/plugin-base.js';
import { logger, client } from '../app.js';
import { UrlHash } from '../modules/browser-utils.js';

// 
// UI Type Definitions
//

/**
 * @typedef {object} loginDialog
 * @property {HTMLFormElement} form
 * @property {SlInput} username
 * @property {SlInput} password
 * @property {SlButton} submit
 * @property {SlButton} [aboutBtn]
 * @property {HTMLDivElement} message
 */

/**
 * @typedef {Object} UserData 
 * @param {string} username
 * @param {string} fullname
 * @param {string[]} roles
 * @param {string} [sessionId]
 */

// Register templates
await registerTemplate('login-dialog', 'login-dialog.html');
await registerTemplate('logout-button', 'logout-button.html');

//
// Authentication Plugin Class
//

class AuthenticationPlugin extends Plugin {
  constructor(context) {
    super(context, { 
      name: 'authentication', 
      deps: ['client'] 
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
    createFromTemplate('login-dialog', document.body);
    

    
    // Prevent dialog from closing
    ui.loginDialog.addEventListener('sl-request-close', (event) => event.preventDefault());
    
    // Add Enter key handling for login
    ui.loginDialog.username.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        ui.loginDialog.password.focus();
      }
    });
    
    ui.loginDialog.password.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        ui.loginDialog.submit.click();
      }
    });
  }

  async start() {
    // add the logout button after all other elements have been added to the toolbar
    const buttonElement = createSingleFromTemplate('logout-button');
    ui.toolbar.insertAdjacentElement("beforeend", buttonElement);
    updateUi();
    ui.toolbar.logoutButton.addEventListener("click", () => this.logout());
  }

  /**
   * React to state changes
   * @param {string[]} changedKeys
   */
  async onStateUpdate(changedKeys) {
    if (changedKeys.includes('user')) {
      ui.toolbar.logoutButton.disabled = this.state?.user === null;
    }
  }

  /**
   * Save session to URL hash on shutdown
   */
  async shutdown() {
    if (this.state?.sessionId) {
      UrlHash.set('sessionId', this.state.sessionId, false);
    }
  }

  //
  // Public API methods
  //

  /**
   * Checks if the user is authenticated. If not, shows a login dialog
   * and returns a promise that resolves only after a successful login.
   * @returns {Promise<UserData>} the userdata
   */
  async ensureAuthenticated() {
    let userData;
    try {
      userData = await client.status();
    } catch (error) {
      // Not authenticated, proceed to show login dialog
      userData = await this._showLoginDialog();
    }
    
    // Only update sessionId if userData contains one (from login), not from status check
    const stateUpdate = { user: userData };
    if (userData.sessionId) {
      // @ts-ignore
      stateUpdate.sessionId = userData.sessionId;
    }
    
    await this.dispatchStateChange(stateUpdate);
    return userData;
  }

  /**
   * Returns the current user or null if none has been authenticated
   * @returns {UserData|null}
   */
  getUser() {
    return this.state?.user;
  }

  /**
   * Shows the login dialog and updates state if login was successful
   */
  async showLoginDialog() {
    try {
      const userData = await this._showLoginDialog();
      await this.dispatchStateChange({
        sessionId: userData.sessionId, 
        user: userData
      });
    } catch (error) {
      logger.error("Error logging in: " + error.message);
    }
  }

  /**
   * Logs the user out
   */
  async logout() {
    try {
      await client.logout();
      logger.info('User logged out successfully');
      await this.dispatchStateChange({
        user: null,
        sessionId: null,
        xml: null,
        pdf: null,
        diff: null
      });
      // re-login
      await this.showLoginDialog();
    } catch (error) {
      logger.critical('Logout failed:' + error);
    }
  }

  //
  // Private methods
  //

  /**
   * Creates and displays the login dialog.
   * @returns {Promise<UserData>} A promise that resolves on successful login with the user data.
   * @private
   */
  async _showLoginDialog() {
    const dialog = ui.loginDialog;
    return new Promise((resolve, reject) => {
      dialog.submit.addEventListener('click', async () => {
        const username = dialog.username.value;
        const password = dialog.password.value;
        dialog.message.textContent = '';
        const passwd_hash = await this._hashPassword(password);
        try {
          const userData = await client.login(username, passwd_hash);
          logger.info(`Login successful for user: ${userData.username}`);
          dialog.hide();
          dialog.username.value = "";
          dialog.password.value = "";
          resolve(userData);
        } catch (error) {
          dialog.message.textContent = 'Wrong username or password';
          logger.error('Login failed:', error.message);
          reject(error);
        }
      }, {once: true});
      dialog.show();
    });
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

// Export the Plugin class - app.js will create singleton and export API
export default AuthenticationPlugin;