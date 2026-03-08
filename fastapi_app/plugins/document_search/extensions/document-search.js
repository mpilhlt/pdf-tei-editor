/**
 * @file Frontend Extension: Document Search
 *
 * Adds a Search button to the backend plugins button group in the toolbar.
 * Clicking it triggers the document-search plugin's search endpoint, which
 * opens the full-text search UI in the standard plugin result dialog.
 */

export const name = 'document-search';
export const description = 'Adds Search button to the toolbar';
export const deps = ['backend-plugins'];

/** @type {HTMLElement|null} */
let searchButton = null;

/**
 * @param {Object} state - Initial application state
 * @param {Object} sandbox - Frontend extension sandbox
 */
export function install(state, sandbox) {}

/**
 * @param {Object} sandbox - Frontend extension sandbox
 */
export function start(sandbox) {
  const state = sandbox.getState();

  searchButton = document.createElement('sl-button');
  searchButton.setAttribute('name', 'searchBtn');
  searchButton.setAttribute('size', 'small');
  searchButton.setAttribute('title', 'Search documents');
  searchButton.innerHTML = '<sl-icon name="search"></sl-icon>';
  searchButton.style.display = state.user ? '' : 'none';

  searchButton.addEventListener('click', () => {
    sandbox.invoke('backend-plugins.execute', ['document-search', 'search', {}]);
  });

  const fileDrawerWidget = sandbox.ui.toolbar.fileDrawerTrigger.closest('sl-tooltip')
    ?? sandbox.ui.toolbar.fileDrawerTrigger;
  sandbox.ui.toolbar.addAfter(searchButton, 9, fileDrawerWidget);
}

/**
 * @param {string[]} changedKeys
 * @param {Object} state
 * @param {Object} sandbox
 */
export function onStateUpdate(changedKeys, state, sandbox) {
  if (changedKeys.includes('user') && searchButton) {
    searchButton.style.display = state.user ? '' : 'none';
  }
}
