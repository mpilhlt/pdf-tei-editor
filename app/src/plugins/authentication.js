/**
 * Plugin that takes care of user authentication
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlButton, SlInput } from '../ui.js'
 */

import ui, { createHtmlElements, SlDialog, updateUi } from '../ui.js';
import { updateState, logger, client, state } from '../app.js';
import { UrlHash } from '../modules/browser-utils.js';

// 
// UI
//

/**
 * @typedef {SlDialog & {
 *  form: HTMLFormElement,
 *  username: SlInput,
 *  password: SlInput,
 *  submit: SlButton,
 *  message: HTMLDivElement
 * }} loginDialog
 */

await createHtmlElements('login-dialog.html', document.body)
const buttonElement = (await createHtmlElements('logout-button.html'))[0]

/**
 * Public API for the authentication plugin
 */
const api = {
  restoreSessionFromUrl,
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
/** @type {UserData} */
let user = null;

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
  // @ts-ignore
  ui.toolbar.self.insertAdjacentElement("beforeend", buttonElement)
  updateUi()
  ui.toolbar.logoutButton.addEventListener("click", logout)
  // prevent dialog from closing
  ui.loginDialog.addEventListener('sl-request-close', (event) => event.preventDefault())
  
  // Add beforeunload handler to save session to URL hash
  window.addEventListener('beforeunload', () => {
    if (state.sessionId) {
      UrlHash.set('sessionId', state.sessionId)
    }
  })
}

/**
 * Handles state updates, specifically for updating the UI based on user login status.
 * @param {ApplicationState} state
 */
async function update(state) {
  if (state.user !== user) {
    user = state.user;
    ui.toolbar.logoutButton.disabled = user === null
  }
}

/**
 * Restores session ID from URL hash if present, then clears it from URL.
 * @param {ApplicationState} state 
 * @returns {Promise<void>}
 */
async function restoreSessionFromUrl(state) {
  const sessionId = UrlHash.get('sessionId')
  if (sessionId) {
    logger.info(`Restoring session from URL: ${sessionId}`)
    await updateState(state, {sessionId})
    // Immediately remove from URL for security
    UrlHash.remove('sessionId')
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
    await updateState(state, { user: null, sessionId: null });
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
