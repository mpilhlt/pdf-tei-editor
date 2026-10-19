/**
 * @file Frontend Extension: Document Search
 *
 * Adds a Search button to the left zone of the toolbar, after the file drawer button.
 * Clicking it triggers the document-search plugin's search endpoint, which
 * opens the full-text search UI in the standard plugin result dialog.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 */

export default class DocumentSearchExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'document-search', deps: ['backend-plugins'] });
  }

  static extensionPoints = ['toolbar.contentItems'];

  /** @type {HTMLElement|null} */
  _searchButton = null;

  async install(state) {
    await super.install(state);
    this._searchButton = document.createElement('sl-button');
    this._searchButton.setAttribute('name', 'searchBtn');
    this._searchButton.setAttribute('size', 'small');
    this._searchButton.setAttribute('title', 'Search documents');
    this._searchButton.innerHTML = '<sl-icon name="search"></sl-icon>';
    this._searchButton.style.display = state.user ? '' : 'none';

    this._searchButton.addEventListener('click', () => {
      this.getDependency('backend-plugins').execute('document-search', 'search', {});
    });
  }

  /**
   * Extension point handler for `toolbar.contentItems`.
   * Called by ToolbarPlugin during start() to collect the search button, which goes into the
   * left zone after the file drawer button (priority 10) and the dashboard button (9.5).
   * Delegates to {@link DocumentSearchExtension#getToolbarItems}.
   * @returns {Array<{element: HTMLElement, priority: number, position: string}>}
   */
  ['toolbar.contentItems']() {
    return this.getToolbarItems();
  }

  /**
   * @returns {Array<{element: HTMLElement, priority: number, position: string}>}
   */
  getToolbarItems() {
    return [{ element: this._searchButton, priority: 9, position: 'left' }];
  }

  async onUserChange(newUser) {
    if (this._searchButton) {
      this._searchButton.style.display = newUser ? '' : 'none';
    }
  }
}
