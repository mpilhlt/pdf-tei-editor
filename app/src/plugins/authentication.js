/**
 * Plugin that takes care of user authentication
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlButton, SlInput } from '../ui.js'
 */

import ui, { SlDialog, updateUi } from '../ui.js';
import { registerTemplate, createFromTemplate, createSingleFromTemplate } from '../modules/ui-system.js';
import { updateState, hasStateChanged, logger, client, state } from '../app.js';
import { UrlHash } from '../modules/browser-utils.js';

// 
// UI
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

// Register templates
await registerTemplate('login-dialog', 'login-dialog.html');
await registerTemplate('logout-button', 'logout-button.html');

/**
 * Public API for the authentication plugin
 */
const api = {
  ensureAuthenticated,
  getUser,
  logout
};

/**
 * Plugin definition
 */
const plugin = {
  name: "authentication",
  deps: ['client'],
  install,
  state: {update}
};

export { api, plugin };

//
// State
//

/**
 * @typedef {Object} UserData 
 * @param {string} username
 * @param {string} fullname
 * @param {string[]} roles
 */
// Note: user state tracking now handled via state.previousState instead of local variable

//
// Implementation
//

/**
 * Installs the plugin.
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`);
  state.user = null;
  
  // Create UI elements
  createFromTemplate('login-dialog', document.body);
  const buttonElement = createSingleFromTemplate('logout-button');
  
  // @ts-ignore - insertAdjacentElement type issue
  ui.toolbar.insertAdjacentElement("beforeend", buttonElement)
  updateUi()
  ui.toolbar.logoutButton.addEventListener("click", logout)
  // prevent dialog from closing
  ui.loginDialog.addEventListener('sl-request-close', (event) => event.preventDefault())
  
  // Add Enter key handling for login
  ui.loginDialog.username.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      ui.loginDialog.password.focus()
    }
  })
  ui.loginDialog.password.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      ui.loginDialog.submit.click()
    }
  })
  
  // Add beforeunload handler to save session to URL hash
  window.addEventListener('beforeunload', () => {
    if (state.sessionId) {
      UrlHash.set('sessionId', state.sessionId, false)
    }
  })
}

/**
 * The current user
 * @type {UserData}
 */
let user

/**
 * Handles state updates, specifically for updating the UI based on user login status.
 * @param {ApplicationState} state
 */
async function update(state) {
  if (hasStateChanged(state, 'user')) {
    user = state.user
    ui.toolbar.logoutButton.disabled = user === null
  }
}

/**
 * Checks if the user is authenticated. If not, it shows a login dialog
 * and returns a promise that resolves only after a successful login.
 * @returns {Promise<Object>} the userdata
 */
async function ensureAuthenticated() {
  try {
    const userData = await client.status();
    await updateState(state, { user: userData });
    return userData
  } catch (error) {
    // Not authenticated, proceed to show login dialog
    return _showLoginDialog();
  }
}

/**
 * Returns the current user or null if none has been authenticated
 * @returns {UserData|null}
 */
function getUser() {
  return user
}

/**
 * Creates and displays the login dialog.
 * @returns {Promise<Object>} A promise that resolves on successful login with the user data.
 * @private
 */
function _showLoginDialog() {
  const dialog = ui.loginDialog
  return new Promise(resolve => {
    dialog.submit.addEventListener('click', async () => {
      const username = dialog.username.value;
      const password = dialog.password.value;
      dialog.message.textContent = '';
      const passwd_hash = await _hashPassword(password);
      try {
        const response = await client.login(username, passwd_hash);
        // Server now returns sessionId in response
        const { sessionId, ...userData } = response;
        await updateState(state, { user: userData, sessionId });
        dialog.hide();
        dialog.username.value = ""
        dialog.password.value = ""
        resolve(userData); // Resolve the promise on successful login
      } catch (error) {
        dialog.message.textContent = 'Wrong username or password';
        logger.error('Login failed:', error.message);
      }
    }, {once:true});
    dialog.show();
  });
}

/**
 * Logs the user out.
 * @private
 */
async function logout() {
  try {
    await client.logout();
    await updateState(state, { 
      user: null, 
      sessionId: null,
      xml: null,
      pdf: null,
      diff: null
    });
    // Remove session from URL hash if present
    UrlHash.remove('sessionId')
    await _showLoginDialog();
  } catch (error) {
    logger.error('Logout failed:', error);
  }
}

/**
 * Hashes a password using SHA-256.
 * @param {string} password
 * @returns {Promise<string>}
 * @private
 */
async function _hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
