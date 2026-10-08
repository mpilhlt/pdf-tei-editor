/**
 * @file Frontend Extension: Revision Feed
 * Adds a "Revision Feeds" entry to the user menu. Shows the user's
 * per-project Atom feed URLs (token-authenticated) and lets them
 * regenerate their feed token.
 *
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 */

export default class RevisionFeedExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'revision-feed', deps: ['dialog'] });
  }

  static extensionPoints = ['toolbar.menuItems'];

  /** @type {HTMLElement} */
  #menuItem = null;

  /** @type {HTMLElement} */
  #dialog = null;

  /** @type {HTMLElement} */
  #feedList = null;

  /** @type {HTMLElement} */
  #regenerateButton = null;

  /**
   * @param {Object} state - Initial application state
   */
  async install(state) {
    await super.install(state);

    this.#menuItem = document.createElement('sl-menu-item');
    this.#menuItem.innerHTML = '<sl-icon slot="prefix" name="rss"></sl-icon>Revision Feeds';
    this.#menuItem.dataset.testId = 'revision-feed-menu-item';
    this.#menuItem.addEventListener('click', () => this.#openDialog());

    this.#buildDialog();
  }

  #buildDialog() {
    this.#dialog = document.createElement('sl-dialog');
    this.#dialog.label = 'Revision Feeds';
    this.#dialog.dataset.testId = 'revision-feed-dialog';

    this.#feedList = document.createElement('div');
    this.#dialog.appendChild(this.#feedList);

    this.#regenerateButton = document.createElement('sl-button');
    this.#regenerateButton.slot = 'footer';
    this.#regenerateButton.variant = 'warning';
    this.#regenerateButton.textContent = 'Regenerate token';
    this.#regenerateButton.dataset.testId = 'revision-feed-regenerate-btn';
    this.#regenerateButton.addEventListener('click', () => this.#regenerateToken());

    const closeButton = document.createElement('sl-button');
    closeButton.slot = 'footer';
    closeButton.variant = 'primary';
    closeButton.textContent = 'Close';
    closeButton.addEventListener('click', () => this.#dialog.hide());

    this.#dialog.appendChild(this.#regenerateButton);
    this.#dialog.appendChild(closeButton);

    document.body.appendChild(this.#dialog);
  }

  async #openDialog() {
    const data = await this.callPluginApi('/api/plugins/revision-feed/my-feeds');
    this.#renderFeeds(data.feeds);
    this.#dialog.show();
  }

  async #regenerateToken() {
    const confirmed = await this.getDependency('dialog').confirm(
      'This will invalidate all previously shared feed URLs. Continue?',
      'Regenerate token'
    );
    if (!confirmed) {
      return;
    }

    this.#regenerateButton.disabled = true;
    try {
      const data = await this.callPluginApi('/api/plugins/revision-feed/token/regenerate', 'POST');
      this.#renderFeeds(data.feeds);
      this.getDependency('dialog').info('Feed token regenerated. Previous feed URLs no longer work.');
    } finally {
      this.#regenerateButton.disabled = false;
    }
  }

  /**
   * @param {Array<{project_id: string, project_name: string, url: string}>} feeds
   */
  #renderFeeds(feeds) {
    this.#feedList.innerHTML = '';

    if (feeds.length === 0) {
      const empty = document.createElement('p');
      empty.dataset.testId = 'revision-feed-empty-message';
      empty.textContent = 'You are not a member of any project yet.';
      this.#feedList.appendChild(empty);
      return;
    }

    for (const feed of feeds) {
      const row = document.createElement('div');
      row.style.marginBottom = '0.75rem';

      const label = document.createElement('div');
      label.textContent = feed.project_name;
      label.style.fontWeight = 'bold';

      const input = document.createElement('sl-input');
      input.value = feed.url;
      input.readonly = true;
      input.dataset.testId = `revision-feed-url-${feed.project_id}`;

      const copyButton = document.createElement('sl-button');
      copyButton.slot = 'suffix';
      copyButton.size = 'small';
      copyButton.innerHTML = '<sl-icon name="clipboard"></sl-icon>';
      copyButton.addEventListener('click', async () => {
        await navigator.clipboard.writeText(feed.url);
        this.getDependency('dialog').info('Feed URL copied to clipboard.');
      });
      input.appendChild(copyButton);

      row.appendChild(label);
      row.appendChild(input);
      this.#feedList.appendChild(row);
    }
  }

  /**
   * Extension point handler for `toolbar.menuItems`.
   * Called by ToolbarPlugin during start() to collect this plugin's user-menu contribution.
   * Delegates to {@link RevisionFeedExtension#getMenuItems}.
   * @returns {Array<{element: HTMLElement}>}
   */
  ['toolbar.menuItems']() {
    return this.getMenuItems();
  }

  /**
   * @returns {Array<{element: HTMLElement}>}
   */
  getMenuItems() {
    return [{ element: this.#menuItem }];
  }
}
