/**
 * @file Frontend Extension: Document Search
 *
 * Adds a Search button to the backend plugins button group in the toolbar.
 * Clicking it triggers the document-search plugin's search endpoint, which
 * opens the full-text search UI in the standard plugin result dialog.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 */

export default class DocumentSearchExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'document-search', deps: ['backend-plugins'] });
  }

  /** @type {HTMLElement|null} */
  _searchButton = null;

  async start() {
    this._searchButton = document.createElement('sl-button');
    this._searchButton.setAttribute('name', 'searchBtn');
    this._searchButton.setAttribute('size', 'small');
    this._searchButton.setAttribute('title', 'Search documents');
    this._searchButton.innerHTML = '<sl-icon name="search"></sl-icon>';
    this._searchButton.style.display = this.state.user ? '' : 'none';

    this._searchButton.addEventListener('click', () => {
      this.getDependency('backend-plugins').execute('document-search', 'search', {});
    });

    const ui = this.getDependency('ui');
    const fileDrawerWidget = ui.toolbar.fileDrawerTrigger.closest('sl-tooltip')
      ?? ui.toolbar.fileDrawerTrigger;
    ui.toolbar.addAfter(this._searchButton, 9, fileDrawerWidget);
  }

  async onUserChange(newUser) {
    if (this._searchButton) {
      this._searchButton.style.display = newUser ? '' : 'none';
    }
  }
}
