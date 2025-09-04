/**
 * Plugin that takes care of user authentication
 */

/** 
 * @import { ApplicationState } from '../app.js' 
 * @import { SlButton, SlInput } from '../ui.js'
 */

import ui, { SlDialog, updateUi } from '../ui.js';
import { registerTemplate, createFromTemplate, createSingleFromTemplate } from '../modules/ui-system.js';
import { updateState, hasStateChanged, logger, client } from '../app.js';
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
  showLoginDialog,
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

/**
 * @typedef {Object} UserData 
 * @param {string} username
 * @param {string} fullname
 * @param {string[]} roles
 * @param {string} [sessionId]
 */

//
// Implementation
//

/**
 * Installs the plugin.
 * @param {ApplicationState} state
 */
async function install(state) {
  logger.debug(`Installing plugin "${plugin.name}"`);
  
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
    if (currentState.sessionId) {
      UrlHash.set('sessionId', currentState.sessionId, false)
    }
  })
}

/**
 * The current state
 * @type {ApplicationState}
 */
let currentState

/**
 * Handles state updates, specifically for updating the UI based on user login status.
 * @param {ApplicationState} state
 */
async function update(state) {
  console.log('DEBUG authentication update - received state:', state)
  console.log('DEBUG authentication update - previous currentState:', currentState)
  currentState = state
  console.log('DEBUG authentication update - updated currentState:', currentState)
  if (hasStateChanged(state, 'user')) {
    console.log('DEBUG authentication update - user changed:', state.user)
    ui.toolbar.logoutButton.disabled = currentState.user === null
  }
  if (hasStateChanged(state, 'sessionId')) {
    console.log('DEBUG authentication update - sessionId changed:', state.sessionId)
  }
}

/**
 * Checks if the user is authenticated. If not, it shows a login dialog
 * and returns a promise that resolves only after a successful login.
 * @returns {Promise<UserData>} the userdata
 */
async function ensureAuthenticated() {
  let userData;
  try {
    userData = await client.status();
    console.log('DEBUG ensureAuthenticated - user from server', userData)
    console.log('DEBUG ensureAuthenticated - current state before update:', currentState)
  } catch (error) {
    console.log('DEBUG ensureAuthenticated - not authenticated, showing login dialog')
    // Not authenticated, proceed to show login dialog
    userData = await _showLoginDialog();
  }
  console.log('DEBUG ensureAuthenticated - updating state with userData:', userData)
  // Only update sessionId if userData contains one (from login), not from status check
  const stateUpdate = { user: userData }
  if (userData.sessionId) {
    console.log('DEBUG ensureAuthenticated - userData has sessionId, updating it:', userData.sessionId)
    stateUpdate.sessionId = userData.sessionId
  } else {
    console.log('DEBUG ensureAuthenticated - userData has no sessionId, keeping existing sessionId:', currentState.sessionId)
  }
  await updateState(currentState, stateUpdate)
  console.log('DEBUG ensureAuthenticated - state updated, new currentState:', currentState)
  return userData
}

/**
 * Returns the current user or null if none has been authenticated
 * @returns {UserData|null}
 */
function getUser() {
  return currentState.user
}

/**
 * Shows the login dialog and mutates the state if 
 * login was successful
 */
async function showLoginDialog() {
  try {
    const userData = await _showLoginDialog()
    console.log('DEBUG showLoginDialog - got userData:', userData)
    console.log('DEBUG showLoginDialog - currentState before update:', currentState)
    await updateState(currentState, {sessionId: userData.sessionId, user: userData})
    console.log('DEBUG showLoginDialog - state updated, new currentState:', currentState)
  } catch (error) {
    logger.error("Error logging in: " + error.message)
  }
}

/**
 * Creates and displays the login dialog.
 * @returns {Promise<UserData>} A promise that resolves on successful login with the user data.
 * @private
 */
async function _showLoginDialog() {
  const dialog = ui.loginDialog
  return new Promise((resolve, reject) => {
    dialog.submit.addEventListener('click', async () => {
      const username = dialog.username.value;
      const password = dialog.password.value;
      dialog.message.textContent = '';
      const passwd_hash = await _hashPassword(password);
      try {
        const userData = await client.login(username, passwd_hash);
        console.log('DEBUG _showLoginDialog - login successful, userData:', userData)
        dialog.hide();
        dialog.username.value = ""
        dialog.password.value = ""
        resolve(userData); 
      } catch (error) {
        dialog.message.textContent = 'Wrong username or password';
        logger.error('Login failed:', error.message);
        reject(error);
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
    await updateState(currentState, { 
      user: null, 
      sessionId: null,
      xml: null,
      pdf: null,
      diff: null
    });
    // re-login
    await showLoginDialog();
  } catch (error) {
    logger.error('Logout failed:' +  error);
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
