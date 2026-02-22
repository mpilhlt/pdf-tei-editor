/**
 * Authentication plugin using the new class-based architecture
 */

/** 
 * @import { ApplicationState } from '../state.js' 
 * @import { SlButton, SlInput } from '../ui.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 */

import ui from '../ui.js';
import { registerTemplate, createFromTemplate } from '../modules/ui-system.js';
import Plugin from '../modules/plugin-base.js';
import { logger, client, config } from '../app.js';
import { UrlHash } from '../modules/browser-utils.js';
import { FiledataPlugin } from '../plugins.js';
import { SessionActivityTracker } from '../modules/session-activity-tracker.js';

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
 * @property {HTMLDivElement} loginMessage
 */

/**
 * @typedef {Object} UserData 
 * @property {string} username
 * @property {string} fullname
 * @property {string[]} roles
 */

/**
 * @typedef { UserData & {sessionId: string} } AuthenticationData
 */

// Register templates
await registerTemplate('login-dialog', 'login-dialog.html');

//
// Authentication Plugin Class
//

class AuthenticationPlugin extends Plugin {
  /**
   * @param {PluginContext} context
   */
  constructor(context) {
    super(context, {
      name: 'authentication',
      deps: ['client']
    });
    /** @type {SessionActivityTracker|null} */
    this.activityTracker = null;
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
    // Initialize session activity tracker
    await this._initializeActivityTracker();
  }

  /**
   * React to state changes
   */
  async onStateUpdate() {
    // No UI updates needed - user menu is handled by user-account plugin
  }

  /**
   * Save session to URL hash on shutdown
   */
  async shutdown() {
    // Stop activity tracker
    if (this.activityTracker) {
      this.activityTracker.stop();
      this.activityTracker = null;
    }

    // release lock - this really should be in xmleditor plugin but the shutdown endpoint will be called only after this
    if (this.state?.xml) {
      try {
        await client.releaseLock(this.state?.xml)
      } catch (_e) {
        // Ignore network errors during page unload
      }
    }
    // Save session ID to URL hash so it can be restored on next load
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
   * @returns {Promise<UserData>} the authentication status data
   */
  async ensureAuthenticated() {
    /** @type {AuthenticationData} */
    let authData;
    try {
      authData = await client.status();
    } catch (error) {
      // Not authenticated, proceed to show login dialog
       authData = await this.showLoginDialog();
    }

    // Only update sessionId if userData contains one (from login), not from status check
    const stateUpdate = { user: authData };
    if (authData.sessionId) {
      // @ts-ignore
      stateUpdate.sessionId = authData.sessionId;
    }

    await this.dispatchStateChange(stateUpdate);

    // Reload file data after authentication to get user-specific files
    try {
      await FiledataPlugin.getInstance().reload({ refresh: true });
      logger.debug('File data reloaded after authentication');
    } catch (error) {
      logger.error('Failed to reload file data after authentication: ' + String(error));
    }

    return authData;
  }

  /**
   * Returns the current user or null if none has been authenticated
   * @returns {UserData|null}
   */
  getUser() {
    return this.state?.user || null;
  }

  /**
   * Shows the login dialog and updates state if login was successful,
   * otherwise shows it again in a loop until correct authentication data is supplied
   * @returns {Promise<AuthenticationData>}
   */
  async showLoginDialog() {
    let authData
    while (true) {
      try {
        authData = await this._showLoginDialog();
        await this.dispatchStateChange({
          sessionId: authData.sessionId, 
          user: authData
        });
        break;
      } catch (error) {
        logger.error("Error logging in: " + String(error));
      }
    }
    return authData
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

      // Reload file data after re-login to get new user's files
      try {
        await FiledataPlugin.getInstance().reload({ refresh: true });
        logger.debug('File data reloaded after logout/re-login');
      } catch (error) {
        logger.error('Failed to reload file data after re-login: ' + String(error));
      }
    } catch (error) {
      logger.critical('Logout failed:' + error);
    }
  }

  //
  // Private methods
  //

  /**
   * Creates and displays the login dialog for one login attenpt
   * @returns {Promise<AuthenticationData>} A promise that resolves on successful login with 
   * the user data or rejects in case the credentials are wrong
   */
  async _showLoginDialog() {
    const dialog = ui.loginDialog;

    // Load and display login message if configured
    const loginMessage = await config.get("application.login-message")
    if (loginMessage) {
      dialog.loginMessage.innerHTML = loginMessage;
      dialog.loginMessage.style.display = 'block';
    } else {
      dialog.loginMessage.innerHTML = '';
      dialog.loginMessage.style.display = 'none';
    }

    return new Promise((resolve, reject) => {
      dialog.submit.addEventListener('click', async () => {
        const username = dialog.username.value;
        const password = dialog.password.value;
        dialog.message.textContent = '';
        const passwd_hash = await this._hashPassword(password);
        try {
          const authData = await client.login(username, passwd_hash);
          logger.info(`Login successful for user: ${authData.username}`);
          dialog.hide();
          dialog.username.value = "";
          resolve(authData);
        } catch (error) {
          dialog.message.textContent = 'Wrong username or password';
          logger.error('Login failed: ' + String(error))
          reject(error);
        } finally {
          dialog.password.value = "";
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

  /**
   * Initialize or reinitialize the session activity tracker
   * @private
   */
  async _initializeActivityTracker() {
    // Get session timeout from config
    const sessionTimeout = await config.get('session.timeout');

    // Stop existing tracker if any
    if (this.activityTracker) {
      this.activityTracker.stop();
    }

    // Create new tracker
    this.activityTracker = new SessionActivityTracker({
      sessionTimeout,
      onLogout: async () => {
        logger.info('Session expired due to inactivity. Logging out automatically.');
        await this.logout();
      },
      logger
    });

    logger.debug(`Session activity tracker initialized with ${sessionTimeout}s timeout`);
  }
}

//
// Exports
//

// Export the Plugin class - app.js will create singleton and export API
export default AuthenticationPlugin;