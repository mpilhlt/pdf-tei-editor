/**
 * Plugin that takes care of user authentication
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlButton, SlInput } from '../ui.js'
 */

import ui, { createHtmlElements, SlDialog, updateUi } from '../ui.js';
import { updateState, logger, client, state } from '../app.js';
import { v4 as uuidv4 } from 'uuid';

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
  updateStateSessionId,
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
 * Ensures that a session id exists in the state and generates a random one if not. 
 * @param {ApplicationState} state 
 * @returns {Promise<string>} the session id 
 */
async function updateStateSessionId(state) {
  const sessionId = state.sessionId || uuidv4()
  logger.info(`Session id is ${sessionId}`)
  await updateState(state, {sessionId})
  return sessionId
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
        const userData = await client.login(username, passwd_hash);
        await updateState(state, { user: userData });
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
    await updateStateSessionId(state)
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
