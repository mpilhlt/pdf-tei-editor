/**
 * User account management plugin - provides user menu with profile editing
 */

/**
 * @import { ApplicationState } from '../state.js'
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { userProfileDialogPart } from '../templates/user-profile-dialog.types.js'
 * @import { userMenuItemsPart } from '../templates/user-menu-items.types.js'
 */

import { registerTemplate, createSingleFromTemplate, createFromTemplate } from '../modules/ui-system.js';
import Plugin from '../modules/plugin-base.js';
import ep from '../extension-points.js';
import { notify } from '../modules/sl-utils.js';

// Register templates
await registerTemplate('user-profile-dialog', 'user-profile-dialog.html');
await registerTemplate('user-menu-items', 'user-menu-items.html');

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

  static extensionPoints = [ep.toolbar.menuItems];

  /**
   * Extension point handler for `ep.toolbar.menuItems`.
   * Called by ToolbarPlugin during start() to collect this plugin's toolbar menu contributions.
   * @returns {Array<{element: HTMLElement}>}
   */
  [ep.toolbar.menuItems]() {
    return [...this.#menuUi.children].map(element => ({ element }))
  }

  get #logger() { return this.getDependency('logger') }
  get #client()  { return this.getDependency('client') }

  /** @type {import('../ui.js').SlDialog & userProfileDialogPart} */
  #dialogUi = null

  /** @type {HTMLElement & userMenuItemsPart} */
  #menuUi = null

  /**
   * @param {ApplicationState} initialState
   */
  async install(initialState) {
    await super.install(initialState);
    this.#logger.debug(`Installing plugin "${this.name}"`);

    const dialog = createSingleFromTemplate('user-profile-dialog', document.body);
    this.#dialogUi = this.createUi(dialog);

    this.#dialogUi.addEventListener('sl-request-close', (event) => {
      if (event.detail.source === 'overlay') {
        event.preventDefault();
      }
    });

    const container = document.createElement('div');
    createFromTemplate('user-menu-items', container);
    this.#menuUi = this.createUi(container);

    this.#menuUi.profileMenuItem.addEventListener('click', () => this.showProfileDialog());
    this.#menuUi.logoutMenuItem.addEventListener('click', () => this.logout());

    this._setupFormHandlers();
  }

  async start() {
    this.#logger.debug(`Starting plugin "${this.name}"`);
  }

  /**
   * @param {ApplicationState['user']} user
   */
  onUserChange(user) {
    this.getDependency('toolbar').setMenuButtonDisabled(user === null);
  }

  async showProfileDialog() {
    const user = this.state?.user;
    if (!user) {
      this.#logger.error('No user logged in');
      return;
    }

    this.#dialogUi.profileForm.fullnameInput.value = user.fullname || '';
    this.#dialogUi.profileForm.emailInput.value = user.email || '';
    this.#dialogUi.profileForm.passwordInput.value = '';
    this.#dialogUi.profileForm.repeatPasswordInput.value = '';
    this.#dialogUi.profileForm.errorMessage.style.display = 'none';

    this.#dialogUi.show();
  }

  async logout() {
    await this.getDependency('authentication').logout();
  }

  _setupFormHandlers() {
    this.#dialogUi.cancelBtn.addEventListener('click', () => {
      this.#dialogUi.hide();
    });

    this.#dialogUi.saveBtn.addEventListener('click', async () => {
      await this._saveProfile();
    });

    this.#dialogUi.profileForm.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this._saveProfile();
      }
    });
  }

  async _saveProfile() {
    const fullname = this.#dialogUi.profileForm.fullnameInput.value.trim();
    const email = this.#dialogUi.profileForm.emailInput.value.trim();
    const password = this.#dialogUi.profileForm.passwordInput.value;
    const repeatPassword = this.#dialogUi.profileForm.repeatPasswordInput.value;

    if (password || repeatPassword) {
      if (password !== repeatPassword) {
        this.#dialogUi.profileForm.errorMessage.textContent = 'Passwords do not match';
        this.#dialogUi.profileForm.errorMessage.style.display = 'block';
        return;
      }
      if (password.length < 6) {
        this.#dialogUi.profileForm.errorMessage.textContent = 'Password must be at least 6 characters';
        this.#dialogUi.profileForm.errorMessage.style.display = 'block';
        return;
      }
    }

    this.#dialogUi.profileForm.errorMessage.style.display = 'none';

    const updateData = { fullname, email };
    if (password) {
      updateData.password = password;
    }

    try {
      const updatedUser = await this.#client.apiClient.usersMeProfile(updateData);

      await this.dispatchStateChange({
        user: {
          username: updatedUser.username,
          fullname: updatedUser.fullname,
          email: updatedUser.email,
          roles: updatedUser.roles
        }
      });

      notify('Profile updated successfully', 'success', 'check-circle');
      this.#dialogUi.hide();
      this.#logger.info('User profile updated successfully');
    } catch (error) {
      this.#logger.error('Error updating profile: ' + String(error));
      this.#dialogUi.profileForm.errorMessage.textContent = 'Failed to update profile: ' + String(error);
      this.#dialogUi.profileForm.errorMessage.style.display = 'block';
    }
  }
}

export default UserAccountPlugin;
