/**
 * Authentication plugin using the new class-based architecture
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { SlDialog } from '../ui.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { loginDialogPart } from '../templates/login-dialog.types.js'
 */

import { registerTemplate, createSingleFromTemplate } from '../modules/ui-system.js';
import Plugin from '../modules/plugin-base.js';

import { SessionActivityTracker } from '../modules/session-activity-tracker.js';

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
      deps: ['client', 'config', 'filedata', 'sse']
    });
    /** @type {SessionActivityTracker|null} */
    this.activityTracker = null;
  }

  get #logger() { return this.getDependency('logger') }
  get #client() { return this.getDependency('client') }
  get #config() { return this.getDependency('config') }

  /** @type {SlDialog & loginDialogPart} */
  #ui = null

  /**
   * Plugin installation - creates UI and sets up event handlers
   * @param {ApplicationState} initialState
   */
  async install(initialState) {
    await super.install(initialState);
    this.#logger.debug(`Installing plugin "${this.name}"`);

    // Create UI elements
    this.#ui = this.createUi(createSingleFromTemplate('login-dialog', document.body))

    // Prevent dialog from closing
    this.#ui.addEventListener('sl-request-close', (event) => event.preventDefault());

    // Add Enter key handling for login
    this.#ui.username.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        this.#ui.password.focus();
      }
    });

    this.#ui.password.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        this.#ui.submit.click();
      }
    });
  }

  async start() {
    // Initialize session activity tracker
    await this._initializeActivityTracker();

    this.getDependency('sse').addEventListener('forceLogout', async (event) => {
      let message = 'Your session has been ended.';
      try {
        const data = JSON.parse(event.data);
        if (data.message) message = data.message;
      } catch (_e) { /* ignore */ }
      alert(message);
      await this.logout();
    });
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
        await this.#client.releaseLock(this.state?.xml)
      } catch (_e) {
        // Ignore network errors during page unload
      }
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
      authData = await this.#client.status();
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
      await this.getDependency('filedata').reload({ refresh: true });
      this.#logger.debug('File data reloaded after authentication');
    } catch (error) {
      this.#logger.error('Failed to reload file data after authentication: ' + String(error));
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
        this.#logger.error("Error logging in: " + String(error));
      }
    }
    return authData
  }

  /**
   * Hides the login dialog without logging out
   */
  hideLoginDialog() {
    this.#ui.hide()
  }

  /**
   * Appends an element to the login dialog
   * @param {HTMLElement} element
   */
  appendToLoginDialog(element) {
    this.#ui.insertAdjacentElement('beforeend', element)
  }

  /**
   * Logs the user out
   */
  async logout() {
    try {
      await this.#client.logout();
      this.#logger.info('User logged out successfully');
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
        await this.getDependency('filedata').reload({ refresh: true });
        this.#logger.debug('File data reloaded after logout/re-login');
      } catch (error) {
        this.#logger.error('Failed to reload file data after re-login: ' + String(error));
      }
    } catch (error) {
      this.#logger.critical('Logout failed:' + error);
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
    // Load and display login message if configured
    const loginMessage = await this.#config.get("application.login-message")
    if (loginMessage) {
      this.#ui.loginMessage.innerHTML = loginMessage;
      this.#ui.loginMessage.style.display = 'block';
    } else {
      this.#ui.loginMessage.innerHTML = '';
      this.#ui.loginMessage.style.display = 'none';
    }

    return new Promise((resolve, reject) => {
      this.#ui.submit.addEventListener('click', async () => {
        const username = this.#ui.username.value;
        const password = this.#ui.password.value;
        this.#ui.message.textContent = '';
        const passwd_hash = await this._hashPassword(password);
        try {
          const authData = await this.#client.login(username, passwd_hash);
          this.#logger.info(`Login successful for user: ${authData.username}`);
          this.#ui.hide();
          this.#ui.username.value = "";
          resolve(authData);
        } catch (error) {
          this.#ui.message.textContent = 'Wrong username or password';
          this.#logger.info('Login failed: ' + String(error))
          reject(error);
        } finally {
          this.#ui.password.value = "";
        }
      }, {once: true});
      this.#ui.show();
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
    const sessionTimeout = await this.#config.get('session.timeout');

    // Stop existing tracker if any
    if (this.activityTracker) {
      this.activityTracker.stop();
    }

    // Create new tracker
    this.activityTracker = new SessionActivityTracker({
      sessionTimeout,
      onLogout: async () => {
        this.#logger.info('Session expired due to inactivity. Logging out automatically.');
        await this.logout();
      },
      logger: this.#logger
    });

    this.#logger.debug(`Session activity tracker initialized with ${sessionTimeout}s timeout`);
  }
}

//
// Exports
//

// Export the Plugin class - app.js will create singleton and export API
export default AuthenticationPlugin;