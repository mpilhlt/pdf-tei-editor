/**
 * Inference Settings Plugin
 *
 * Generic core plugin exposing a shared "default LLM model" that any
 * LLM-consuming plugin can read via getDefaultModel() and fall back to
 * unless it has its own explicit per-call override. Adds a Tools menu entry
 * (new "inference" category) listing every available provider's models,
 * fetched from GET /api/v1/llm/providers, with a warning icon when a
 * model's live status isn't "available". The entry's own label reads
 * "Default Model" until a selection is made, then "<provider>/<model>";
 * selecting a model also toasts a confirmation naming it.
 *
 * See docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md
 * (Part F) for the design rationale.
 *
 * Refresh on next submenu open: sl-menu-item exposes no public "submenu
 * opened" event, so the submenu is instead refreshed on the parent item's
 * `mouseenter` - close enough to "about to open" to self-correct a stale
 * busy-status or a since-removed provider/model without a dedicated poll.
 *
 * Startup-blocking and auth timing: this plugin is registered (plugins.js)
 * and started (application.js's sequential ep.start) well before
 * StartPlugin, which is what calls ensureAuthenticated(). That means (a)
 * start() must not await its network fetch, or it would stall every app
 * load behind GET /api/v1/llm/providers (which can take up to a real
 * provider's timeout, e.g. ~30s for KISSKI, if unreachable), and (b) the
 * very first _refresh() call happens pre-authentication and typically
 * 401s, which is caught and logged as a warning, leaving _providers empty.
 * onSessionIdChange() - auto-discovered by plugin-base.js's on<Key>Change
 * convention from the `sessionId` state property (state.js) - is what
 * actually (re)populates _providers once a valid session exists.
 */

import { Plugin } from '../modules/plugin-base.js';
import { notify } from '../modules/sl-utils.js';

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ProviderResponse, ModelResponse } from '../modules/api-client-v1.js'
 */

export class InferenceSettingsPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'inference-settings', deps: ['client', 'tools'] });
  }

  get #client() { return this.getDependency('client') }
  get #tools() { return this.getDependency('tools') }

  /**
   * Last successful GET /api/v1/llm/providers result. Empty until the
   * first fetch completes (or forever, if every fetch has failed).
   * @type {Array<ProviderResponse>}
   */
  _providers = [];

  /**
   * The submenu (`sl-menu[slot="submenu"]`) listing providers/models,
   * created once in start() and repopulated by _refresh(). Null until
   * start() has run.
   * @type {HTMLElement|null}
   */
  _submenu = null;

  /**
   * The parent "Default Model" `sl-menu-item`, created once in start().
   * Hidden (via inline `display: none`) whenever a successful fetch
   * reports zero providers, so an installation with no configured LLM
   * providers doesn't show an empty entry. Null until start() has run.
   * @type {HTMLElement|null}
   */
  _menuItem = null;

  /**
   * The text node holding the parent item's own label (created once in
   * start(), before the submenu is appended as a sibling child). Kept
   * separate from the submenu so updating the label via `nodeValue` never
   * touches - or is clobbered by resetting - `_menuItem.textContent`, which
   * would wipe the submenu since it's also a child of `_menuItem`. Null
   * until start() has run.
   * @type {Text|null}
   */
  _labelNode = null;

  /**
   * The in-flight _refresh() promise, or null if no fetch is currently
   * running. Prevents overlapping fetches (e.g. rapid re-hovering) from
   * racing each other.
   * @type {Promise<void>|null}
   */
  _refreshPromise = null;

  /**
   * Set when _refresh() is called while a fetch is already in flight (so
   * that call joined the existing promise instead of starting its own).
   * Once the in-flight fetch settles, a single trailing refresh is fired
   * to make sure the most recent caller's intent (e.g. onSessionIdChange()
   * wanting a freshly-authenticated fetch, called while a stale pre-auth
   * fetch was still pending) isn't silently dropped.
   * @type {boolean}
   */
  _refreshQueued = false;

  /**
   * The currently selected default model, or null if nothing has been
   * selected yet, or the stored value no longer matches an available
   * provider/model in the last successful fetch (_providers). Note that
   * this can legitimately return null for a valid stored default until
   * the first successful _refresh() completes - start() does not await
   * its own fetch (see module doc-comment), so _providers stays empty
   * from construction until either that fetch or onSessionIdChange()'s
   * post-login refresh succeeds.
   * @returns {{providerId: string, modelId: string}|null}
   */
  getDefaultModel() {
    const stored = this.uiStorage.get('defaultModel', null);
    if (!stored) return null;
    const provider = this._providers.find(p => p.id === stored.providerId);
    const model = provider?.models.find(m => m.id === stored.modelId);
    return model ? stored : null;
  }

  /**
   * Persist the default model and, if the submenu has been built, update
   * its checked state so only this item appears selected.
   * @param {string} providerId
   * @param {string} modelId
   */
  setDefaultModel(providerId, modelId) {
    this.uiStorage.set('defaultModel', { providerId, modelId });
    this._updateMenuItemLabel();
    if (!this._submenu) return;
    this._submenu.querySelectorAll('sl-menu-item').forEach(el => {
      /** @type {HTMLElement & {checked: boolean}} */ (el).checked =
        el.dataset.providerId === providerId && el.dataset.modelId === modelId;
    });
  }

  /**
   * Sync the parent item's own label (its `_labelNode`, not its
   * `textContent` - see that field's doc-comment) to the currently stored
   * default: "Default Model" when nothing is selected, or the currently
   * matching provider/model no longer resolves against the last fetched
   * `_providers` (e.g. it was removed server-side); "<provider>/<model>"
   * otherwise.
   */
  _updateMenuItemLabel() {
    if (!this._labelNode) return;
    const current = this.getDefaultModel();
    if (!current) {
      this._labelNode.nodeValue = 'Default Model';
      return;
    }
    const provider = this._providers.find(p => p.id === current.providerId);
    const model = provider?.models.find(m => m.id === current.modelId);
    this._labelNode.nodeValue = provider && model ? `${provider.label}/${model.label}` : 'Default Model';
  }

  /**
   * Rebuild the submenu's contents from a provider list: one `<small>`
   * label + one `sl-menu-item[type=checkbox]` per model, checked to match
   * the currently stored default.
   * @param {Array<ProviderResponse>} providers
   */
  _populateSubmenu(providers) {
    this._submenu.innerHTML = '';
    const current = this.getDefaultModel();
    for (const provider of providers) {
      const label = document.createElement('small');
      label.textContent = provider.label;
      this._submenu.appendChild(label);
      for (const model of provider.models) {
        this._submenu.appendChild(this._buildModelItem(provider, model, current));
      }
    }
  }

  /**
   * Build one model's `sl-menu-item[type=checkbox]`. When the model's
   * status isn't "available", attaches a warning tooltip+icon as a
   * `suffix`-slotted child - purely informational, never disables the
   * item. `status` is null for providers that don't expose live load
   * data: no icon in that case, silence rather than a false "available"
   * signal.
   * @param {ProviderResponse} provider
   * @param {ModelResponse} model
   * @param {{providerId: string, modelId: string}|null} current
   * @returns {HTMLElement}
   */
  _buildModelItem(provider, model, current) {
    const item = /** @type {HTMLElement & {type: string, checked: boolean}} */
      (document.createElement('sl-menu-item'));
    item.type = 'checkbox';
    item.textContent = model.label;
    item.dataset.providerId = provider.id;
    item.dataset.modelId = model.id;
    item.checked = !!current && current.providerId === provider.id && current.modelId === model.id;

    if (model.status && model.status.availability !== 'available') {
      const tooltip = /** @type {HTMLElement & {content: string, slot: string}} */ (document.createElement('sl-tooltip'));
      tooltip.slot = 'suffix';
      tooltip.content = `This model is currently ${model.status.availability.replaceAll('_', ' ')}`
        + (model.status.detail ? ` (${model.status.detail})` : '') + ' and may time out.';
      const icon = /** @type {HTMLElement & {name: string}} */ (document.createElement('sl-icon'));
      icon.name = 'exclamation-triangle';
      tooltip.appendChild(icon);
      item.appendChild(tooltip);
    }
    return item;
  }

  /**
   * Handle `sl-select` on the submenu: persist the clicked item's
   * provider/model as the new default and toast a confirmation naming it. A
   * bare item with no data-provider-id/data-model-id (e.g. a future
   * non-model entry) is ignored rather than persisting an incomplete
   * selection or toasting a bogus confirmation.
   * @param {CustomEvent} event
   */
  _onSelect(event) {
    const item = /** @type {HTMLElement} */ (event.detail.item);
    const { providerId, modelId } = item.dataset;
    if (!providerId || !modelId) return;
    this.setDefaultModel(providerId, modelId);
    const provider = this._providers.find(p => p.id === providerId);
    const model = provider?.models.find(m => m.id === modelId);
    if (provider && model) {
      notify(`Default inference model is now: ${provider.label}/${model.label}`);
    }
  }

  /**
   * Build the "Default Model" Tools-menu item + its submenu, register it,
   * and kick off the first provider fetch (not awaited - see module
   * doc-comment on startup-blocking).
   */
  async start() {
    const parentItem = document.createElement('sl-menu-item');
    const labelNode = document.createTextNode('Default Model');
    parentItem.appendChild(labelNode);
    this._menuItem = parentItem;
    this._labelNode = labelNode;

    const submenu = document.createElement('sl-menu');
    submenu.slot = 'submenu';
    parentItem.appendChild(submenu);
    this._submenu = submenu;

    submenu.addEventListener('sl-select', (event) => this._onSelect(/** @type {CustomEvent} */(event)));
    // No public "submenu opened" event exists on sl-menu-item - see the
    // "Refresh on next submenu open" note in this file's module doc-comment.
    parentItem.addEventListener('mouseenter', () => this._refresh());

    this.#tools.addMenuItems([parentItem], 'inference');

    this._refresh();
  }

  /**
   * Re-fetch when the session becomes valid (login) or changes (different
   * user) - the plugin's own start() runs before authentication completes
   * (see module doc-comment), so the very first _refresh() call during
   * start() typically 401s and is silently swallowed; this is what
   * actually populates _providers once the user is authenticated. Not
   * awaited - onStateUpdate.<key> handlers run sequentially under
   * application.js's state-update lock, so awaiting a slow network fetch
   * here would block login/logout the same way start() awaiting it used
   * to block every page load. _refresh() already catches its own errors
   * and never throws.
   */
  onSessionIdChange() {
    this._refresh();
  }

  /**
   * Fetch the current provider/model list and rebuild the submenu. On
   * failure, leaves the previous _providers/submenu state untouched
   * (stale data is more useful than an empty menu) and logs a warning -
   * mirrors backend-plugins.js's discoverPlugins() error handling.
   * Deduplicates concurrent calls: if a fetch is already in flight, this
   * joins that same promise instead of starting a second one - but marks
   * _refreshQueued so that, once the in-flight fetch settles, one trailing
   * refresh is fired automatically. Without this, a call that arrives
   * while a stale fetch is still pending (e.g. onSessionIdChange() firing
   * while start()'s pre-auth request hasn't 401'd yet) would otherwise
   * just observe that stale result instead of getting a fresh one.
   * @returns {Promise<void>}
   */
  async _refresh() {
    if (this._refreshPromise) {
      this._refreshQueued = true;
      return this._refreshPromise;
    }
    this._refreshPromise = this.#doRefresh();
    try {
      await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
      if (this._refreshQueued) {
        this._refreshQueued = false;
        this._refresh();
      }
    }
  }

  /**
   * Does the actual fetch/rebuild work for _refresh(). Split out so
   * _refresh() can wrap it with the in-flight-promise guard.
   * @returns {Promise<void>}
   */
  async #doRefresh() {
    /** @type {Array<ProviderResponse>} */
    let providers;
    try {
      providers = await this.#client.apiClient.llmProviders();
    } catch (error) {
      console.warn('inference-settings: could not load LLM providers:', error);
      return;
    }
    const changed = JSON.stringify(providers) !== JSON.stringify(this._providers);
    this._providers = providers;
    if (this._menuItem) {
      this._menuItem.style.display = providers.length === 0 ? 'none' : '';
    }
    this._updateMenuItemLabel();
    if (this._submenu && changed) {
      this._populateSubmenu(providers);
    }
  }
}

export default InferenceSettingsPlugin;
