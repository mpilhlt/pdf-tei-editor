#!/usr/bin/env node

/**
 * Unit tests for the inference-settings plugin (shared default LLM model).
 * @testCovers app/src/plugins/inference-settings.js
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

// Set up jsdom globals for the DOM the plugin builds (sl-menu / sl-menu-item
// / sl-tooltip / sl-icon are unregistered custom elements under jsdom - they
// behave as plain HTMLElement, which is enough to assert structure/attributes).
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;

// UIStorage defaults to the global `localStorage` binding. jsdom only
// provides window.localStorage when constructed with a `url` option, so
// stub the global directly instead - same pattern as
// tests/unit/js/ui-storage-plugin-integration.test.js.
global.localStorage = (() => {
  const store = {};
  return {
    getItem: (key) => store[key] ?? null,
    setItem: (key, value) => { store[key] = value; },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); }
  };
})();

// notify()'s real implementation instantiates Shoelace's SlAlert and calls
// .toast(), which under jsdom leaves a dangling promise (waiting on a CSS
// transitionend event that jsdom never fires) - stub it, following the
// precedent in config-editor-masked-value.test.js.
const notifyCalls = [];
mock.module('../../../app/src/modules/sl-utils.js', {
  namedExports: {
    notify: (...args) => { notifyCalls.push(args); }
  }
});

const { default: PluginManager } = await import('../../../app/src/modules/plugin-manager.js');
const { default: StateManager } = await import('../../../app/src/modules/state-manager.js');
const { Application } = await import('../../../app/src/modules/application.js');
const { InferenceSettingsPlugin } = await import('../../../app/src/plugins/inference-settings.js');

/** @returns {InstanceType<typeof InferenceSettingsPlugin>} */
function makePlugin() {
  const app = new Application(new PluginManager(), new StateManager());
  const ctx = app.getPluginContext();
  return new InferenceSettingsPlugin(ctx);
}

/**
 * Let any pending microtask chains (e.g. start()'s fire-and-forget
 * _refresh() call) settle before asserting on their result. A macrotask
 * tick (setImmediate) drains the whole microtask queue first, which is
 * more robust than counting await hops through internal implementation
 * details.
 * @returns {Promise<void>}
 */
function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Every test in this file shares the module-level global.localStorage stub
// (UIStorage's persistence layer), so a selection persisted by one test
// (setDefaultModel/_onSelect/a submenu 'sl-select' dispatch) would otherwise
// leak into unrelated later tests - previously invisible because the menu
// item's label was static, but now that it reflects the stored default
// (_updateMenuItemLabel()), a leaked selection changes what later tests see.
beforeEach(() => { global.localStorage.clear(); });

describe('InferenceSettingsPlugin construction', () => {
  it('has the expected name and dependencies', () => {
    const plugin = makePlugin();
    assert.strictEqual(plugin.name, 'inference-settings');
    assert.deepStrictEqual(plugin.deps, ['client', 'tools']);
  });
});

describe('InferenceSettingsPlugin.getDefaultModel/setDefaultModel', () => {
  beforeEach(() => { global.localStorage.clear(); });

  it('returns null when nothing has been selected yet', () => {
    const plugin = makePlugin();
    assert.strictEqual(plugin.getDefaultModel(), null);
  });

  it('persists a selection and returns it once a matching provider/model is cached', () => {
    const plugin = makePlugin();
    plugin._providers = [{
      id: 'kisski', label: 'KISSKI',
      models: [{ id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null }]
    }];
    plugin.setDefaultModel('kisski', 'gemma-3');
    assert.deepStrictEqual(plugin.getDefaultModel(), { providerId: 'kisski', modelId: 'gemma-3' });
  });

  it('falls back to null when the stored default no longer matches an available provider/model', () => {
    const plugin = makePlugin();
    plugin._providers = [{
      id: 'kisski', label: 'KISSKI',
      models: [{ id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null }]
    }];
    plugin.setDefaultModel('kisski', 'gemma-3');
    plugin._providers = []; // provider no longer present on the next fetch
    assert.strictEqual(plugin.getDefaultModel(), null);
  });

  it('falls back to null when the provider is still present but the model id is not', () => {
    const plugin = makePlugin();
    plugin._providers = [{
      id: 'kisski', label: 'KISSKI',
      models: [{ id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null }]
    }];
    plugin.setDefaultModel('kisski', 'gemma-3');
    plugin._providers = [{ id: 'kisski', label: 'KISSKI', models: [] }]; // model removed
    assert.strictEqual(plugin.getDefaultModel(), null);
  });

  it('setDefaultModel does not throw when no submenu has been built yet', () => {
    const plugin = makePlugin();
    assert.doesNotThrow(() => plugin.setDefaultModel('kisski', 'gemma-3'));
  });
});

describe('InferenceSettingsPlugin.getModelLabel', () => {
  it('returns "<provider label>/<model label>" for a known pair', () => {
    const plugin = makePlugin();
    plugin._providers = [{
      id: 'kisski', label: 'KISSKI',
      models: [{ id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null }]
    }];
    assert.strictEqual(plugin.getModelLabel('kisski', 'gemma-3'), 'KISSKI/Gemma 3');
  });

  it('falls back to the raw ids for an unknown pair', () => {
    const plugin = makePlugin();
    assert.strictEqual(plugin.getModelLabel('kisski', 'gemma-3'), 'kisski/gemma-3');
  });
});

describe('InferenceSettingsPlugin._buildModelItem', () => {
  it('builds a checkbox item with provider/model data attributes', () => {
    const plugin = makePlugin();
    const provider = { id: 'kisski', label: 'KISSKI', models: [] };
    const model = { id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null };
    const item = plugin._buildModelItem(provider, model, null);
    assert.strictEqual(item.tagName.toLowerCase(), 'sl-menu-item');
    assert.strictEqual(item.type, 'checkbox');
    assert.strictEqual(item.textContent, 'Gemma 3');
    assert.strictEqual(item.dataset.providerId, 'kisski');
    assert.strictEqual(item.dataset.modelId, 'gemma-3');
    assert.strictEqual(item.checked, false);
  });

  it('checks the item matching the current default', () => {
    const plugin = makePlugin();
    const provider = { id: 'kisski', label: 'KISSKI', models: [] };
    const model = { id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null };
    const item = plugin._buildModelItem(provider, model, { providerId: 'kisski', modelId: 'gemma-3' });
    assert.strictEqual(item.checked, true);
  });

  it('does not check an item that does not match the current default', () => {
    const plugin = makePlugin();
    const provider = { id: 'kisski', label: 'KISSKI', models: [] };
    const model = { id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null };
    const item = plugin._buildModelItem(provider, model, { providerId: 'kisski', modelId: 'other-model' });
    assert.strictEqual(item.checked, false);
  });

  it('adds no tooltip when status is null', () => {
    const plugin = makePlugin();
    const provider = { id: 'kisski', label: 'KISSKI', models: [] };
    const model = { id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null };
    const item = plugin._buildModelItem(provider, model, null);
    assert.strictEqual(item.querySelector('sl-tooltip'), null);
  });

  it('adds no tooltip when status.availability is "available"', () => {
    const plugin = makePlugin();
    const provider = { id: 'kisski', label: 'KISSKI', models: [] };
    const model = {
      id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'],
      status: { availability: 'available', detail: 'demand: 0' }
    };
    const item = plugin._buildModelItem(provider, model, null);
    assert.strictEqual(item.querySelector('sl-tooltip'), null);
  });

  it('adds a warning tooltip+icon when status.availability is "busy"', () => {
    const plugin = makePlugin();
    const provider = { id: 'kisski', label: 'KISSKI', models: [] };
    const model = {
      id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'],
      status: { availability: 'busy', detail: 'demand: 3' }
    };
    const item = plugin._buildModelItem(provider, model, null);
    const tooltip = item.querySelector('sl-tooltip');
    assert.ok(tooltip, 'expected an sl-tooltip child');
    assert.strictEqual(tooltip.slot, 'suffix');
    assert.match(tooltip.content, /currently busy/);
    assert.match(tooltip.content, /demand: 3/);
    const icon = tooltip.querySelector('sl-icon');
    assert.ok(icon, 'expected an sl-icon inside the tooltip');
    assert.strictEqual(icon.name, 'exclamation-triangle');
  });

  it('adds a warning tooltip when status.availability is "very_busy"', () => {
    const plugin = makePlugin();
    const provider = { id: 'kisski', label: 'KISSKI', models: [] };
    const model = {
      id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'],
      status: { availability: 'very_busy', detail: 'demand: 9' }
    };
    const item = plugin._buildModelItem(provider, model, null);
    const tooltip = item.querySelector('sl-tooltip');
    assert.ok(tooltip);
    assert.match(tooltip.content, /currently very busy/);
  });
});

describe('InferenceSettingsPlugin._populateSubmenu', () => {
  it('renders one <small> label plus one item per model, grouped by provider', () => {
    const plugin = makePlugin();
    plugin._submenu = document.createElement('sl-menu');
    const providers = [{
      id: 'kisski', label: 'KISSKI', models: [
        { id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null },
        { id: 'llama-3', label: 'Llama 3', capabilities: ['chat'], status: null },
      ]
    }];
    plugin._populateSubmenu(providers);
    const children = [...plugin._submenu.children];
    assert.strictEqual(children.length, 3);
    assert.strictEqual(children[0].tagName.toLowerCase(), 'small');
    assert.strictEqual(children[0].textContent, 'KISSKI');
    assert.strictEqual(children[1].textContent, 'Gemma 3');
    assert.strictEqual(children[2].textContent, 'Llama 3');
  });

  it('clears previous contents on repeated calls', () => {
    const plugin = makePlugin();
    plugin._submenu = document.createElement('sl-menu');
    const providers = [{ id: 'a', label: 'A', models: [{ id: 'm', label: 'M', capabilities: [], status: null }] }];
    plugin._populateSubmenu(providers);
    plugin._populateSubmenu(providers);
    assert.strictEqual(plugin._submenu.children.length, 2); // not 4
  });

  it('checks the item matching the currently stored default', () => {
    const plugin = makePlugin();
    plugin._submenu = document.createElement('sl-menu');
    const providers = [{ id: 'kisski', label: 'KISSKI', models: [{ id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null }] }];
    plugin._providers = providers;
    plugin.setDefaultModel('kisski', 'gemma-3');
    plugin._populateSubmenu(providers);
    const item = plugin._submenu.querySelector('sl-menu-item');
    assert.strictEqual(item.checked, true);
  });
});

describe('InferenceSettingsPlugin._onSelect', () => {
  it("persists the clicked item's provider/model and updates checked state across siblings", () => {
    const plugin = makePlugin();
    plugin._submenu = document.createElement('sl-menu');
    const providers = [{
      id: 'kisski', label: 'KISSKI', models: [
        { id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null },
        { id: 'llama-3', label: 'Llama 3', capabilities: ['chat'], status: null },
      ]
    }];
    plugin._providers = providers;
    plugin._populateSubmenu(providers);
    const [gemmaItem, llamaItem] = plugin._submenu.querySelectorAll('sl-menu-item');

    plugin._onSelect({ detail: { item: llamaItem } });

    assert.deepStrictEqual(plugin.getDefaultModel(), { providerId: 'kisski', modelId: 'llama-3' });
    assert.strictEqual(llamaItem.checked, true);
    assert.strictEqual(gemmaItem.checked, false);
  });

  it('re-selecting a different item unchecks the previous one', () => {
    const plugin = makePlugin();
    plugin._submenu = document.createElement('sl-menu');
    const providers = [{
      id: 'kisski', label: 'KISSKI', models: [
        { id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null },
        { id: 'llama-3', label: 'Llama 3', capabilities: ['chat'], status: null },
      ]
    }];
    plugin._providers = providers;
    plugin._populateSubmenu(providers);
    const [gemmaItem, llamaItem] = plugin._submenu.querySelectorAll('sl-menu-item');

    plugin._onSelect({ detail: { item: gemmaItem } });
    plugin._onSelect({ detail: { item: llamaItem } });

    assert.strictEqual(gemmaItem.checked, false);
    assert.strictEqual(llamaItem.checked, true);
  });

  it('ignores a selected item with no provider/model data', () => {
    const plugin = makePlugin();
    plugin._submenu = document.createElement('sl-menu');
    const bareItem = document.createElement('sl-menu-item');
    plugin._onSelect({ detail: { item: bareItem } });
    assert.strictEqual(plugin.getDefaultModel(), null);
  });
});

describe('InferenceSettingsPlugin toast notification on selection', () => {
  beforeEach(() => { global.localStorage.clear(); notifyCalls.length = 0; });

  it('shows a toast naming the newly selected provider/model', () => {
    const plugin = makePlugin();
    plugin._submenu = document.createElement('sl-menu');
    const providers = [{
      id: 'kisski', label: 'KISSKI', models: [
        { id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null },
      ]
    }];
    plugin._providers = providers;
    plugin._populateSubmenu(providers);
    const item = plugin._submenu.querySelector('sl-menu-item');

    plugin._onSelect({ detail: { item } });

    assert.strictEqual(notifyCalls.length, 1);
    assert.strictEqual(notifyCalls[0][0], 'Default inference model is now: KISSKI/Gemma 3');
  });

  it('does not show a toast for a selected item with no provider/model data', () => {
    const plugin = makePlugin();
    plugin._submenu = document.createElement('sl-menu');
    const bareItem = document.createElement('sl-menu-item');
    plugin._onSelect({ detail: { item: bareItem } });
    assert.strictEqual(notifyCalls.length, 0);
  });
});

describe('InferenceSettingsPlugin default-model menu item label', () => {
  beforeEach(() => { global.localStorage.clear(); notifyCalls.length = 0; });

  it('shows "Default Model" when nothing is selected yet', async () => {
    const plugin = makePlugin();
    let addedItems;
    const providers = [{
      id: 'kisski', label: 'KISSKI',
      models: [{ id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null }]
    }];
    plugin.getDependency = (name) => {
      if (name === 'tools') return { addMenuItems: (items) => { addedItems = items; } };
      if (name === 'client') return { apiClient: { llmProviders: async () => providers } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin.start();
    await flushMicrotasks();
    assert.strictEqual(addedItems[0].childNodes[0].textContent, 'Default Model');
  });

  it('shows "Provider/Model" once a model has been selected through the submenu', async () => {
    const plugin = makePlugin();
    let addedItems;
    const providers = [{
      id: 'kisski', label: 'KISSKI',
      models: [{ id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null }]
    }];
    plugin.getDependency = (name) => {
      if (name === 'tools') return { addMenuItems: (items) => { addedItems = items; } };
      if (name === 'client') return { apiClient: { llmProviders: async () => providers } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin.start();
    await flushMicrotasks();
    const submenu = addedItems[0].querySelector('sl-menu');
    const modelItem = submenu.querySelector('sl-menu-item');
    submenu.dispatchEvent(new dom.window.CustomEvent('sl-select', { detail: { item: modelItem } }));

    assert.strictEqual(addedItems[0].childNodes[0].textContent, 'KISSKI/Gemma 3');
  });

  it('reverts to "Default Model" once the selected model no longer appears in a refresh', async () => {
    const plugin = makePlugin();
    let addedItems;
    const providers = [{
      id: 'kisski', label: 'KISSKI',
      models: [{ id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null }]
    }];
    plugin.getDependency = (name) => {
      if (name === 'tools') return { addMenuItems: (items) => { addedItems = items; } };
      if (name === 'client') return { apiClient: { llmProviders: async () => providers } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin.start();
    await flushMicrotasks();
    plugin.setDefaultModel('kisski', 'gemma-3');
    assert.strictEqual(addedItems[0].childNodes[0].textContent, 'KISSKI/Gemma 3');

    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { llmProviders: async () => [] } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refresh();
    assert.strictEqual(addedItems[0].childNodes[0].textContent, 'Default Model');
  });
});

describe('InferenceSettingsPlugin._refresh', () => {
  it('populates _providers and rebuilds the submenu on success', async () => {
    const plugin = makePlugin();
    plugin._submenu = document.createElement('sl-menu');
    const providers = [{
      id: 'kisski', label: 'KISSKI',
      models: [{ id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null }]
    }];
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { llmProviders: async () => providers } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refresh();
    assert.deepStrictEqual(plugin._providers, providers);
    assert.strictEqual(plugin._submenu.children.length, 2); // <small> + one item
  });

  it('leaves _providers untouched and does not throw when the fetch fails', async () => {
    const plugin = makePlugin();
    const stale = [{ id: 'stale', label: 'Stale', models: [] }];
    plugin._providers = stale;
    plugin.getDependency = (name) => {
      if (name === 'client') {
        return { apiClient: { llmProviders: async () => { throw new Error('network error'); } } };
      }
      throw new Error(`unexpected dependency: ${name}`);
    };
    await assert.doesNotReject(() => plugin._refresh());
    assert.deepStrictEqual(plugin._providers, stale);
  });

  it('leaves the existing submenu DOM untouched when a later fetch fails', async () => {
    const plugin = makePlugin();
    plugin._submenu = document.createElement('sl-menu');
    const providers = [{
      id: 'kisski', label: 'KISSKI',
      models: [{ id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null }]
    }];
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { llmProviders: async () => providers } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refresh();
    const childrenBefore = [...plugin._submenu.children];
    assert.strictEqual(childrenBefore.length, 2);

    plugin.getDependency = (name) => {
      if (name === 'client') {
        return { apiClient: { llmProviders: async () => { throw new Error('network error'); } } };
      }
      throw new Error(`unexpected dependency: ${name}`);
    };
    await assert.doesNotReject(() => plugin._refresh());

    const childrenAfter = [...plugin._submenu.children];
    assert.strictEqual(childrenAfter.length, 2);
    childrenBefore.forEach((node, i) => assert.strictEqual(childrenAfter[i], node));
  });

  it('skips rebuilding the submenu when the fetched data is unchanged (deep-equal)', async () => {
    const plugin = makePlugin();
    plugin._submenu = document.createElement('sl-menu');
    const providers = [{
      id: 'kisski', label: 'KISSKI',
      models: [{ id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null }]
    }];
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { llmProviders: async () => providers } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refresh();
    const nodeBefore = plugin._submenu.children[1]; // the model item

    // Second refresh with a deep-equal but distinct array/object graph.
    const providersAgain = JSON.parse(JSON.stringify(providers));
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { llmProviders: async () => providersAgain } };
      throw new Error(`unexpected dependency: ${name}`);
    };
    await plugin._refresh();

    assert.strictEqual(plugin._submenu.children.length, 2);
    assert.strictEqual(plugin._submenu.children[1], nodeBefore, 'expected the same DOM node reference, not just an equal one');
  });

  it('fires exactly one trailing refresh when called again while a fetch is in flight', async () => {
    const plugin = makePlugin();
    plugin._submenu = document.createElement('sl-menu');
    let callCount = 0;
    /** @type {(value: Array<object>) => void} */
    let resolveFirst;
    const staleProviders = [{ id: 'stale', label: 'Stale', models: [] }];
    const freshProviders = [{
      id: 'fresh', label: 'Fresh',
      models: [{ id: 'm', label: 'M', capabilities: ['chat'], status: null }]
    }];
    plugin.getDependency = (name) => {
      if (name === 'client') {
        return {
          apiClient: {
            llmProviders: () => {
              callCount++;
              if (callCount === 1) return new Promise((resolve) => { resolveFirst = resolve; });
              return Promise.resolve(freshProviders);
            }
          }
        };
      }
      throw new Error(`unexpected dependency: ${name}`);
    };

    const firstRefresh = plugin._refresh();
    // These join the in-flight fetch (dedup) rather than starting new ones,
    // but each marks _refreshQueued - only one trailing refresh should
    // fire regardless of how many calls arrived while the fetch was busy.
    const secondRefresh = plugin._refresh();
    const thirdRefresh = plugin._refresh();
    assert.strictEqual(callCount, 1, 'expected the in-flight fetch to be reused, not re-triggered');

    resolveFirst(staleProviders);
    await Promise.all([firstRefresh, secondRefresh, thirdRefresh]);
    // The trailing refresh is itself fire-and-forget (kicked off from
    // _refresh()'s finally block without an await), so let it settle too.
    if (plugin._refreshPromise) await plugin._refreshPromise;
    await flushMicrotasks();

    assert.strictEqual(callCount, 2, 'expected exactly one trailing refresh, not one per queued call');
    assert.deepStrictEqual(plugin._providers, freshProviders);
  });
});

describe('InferenceSettingsPlugin.onSessionIdChange', () => {
  it('re-fetches and populates _providers (this is what recovers from the pre-auth 401)', async () => {
    const plugin = makePlugin();
    plugin._submenu = document.createElement('sl-menu');
    const providers = [{
      id: 'kisski', label: 'KISSKI',
      models: [{ id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null }]
    }];
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { llmProviders: async () => providers } };
      throw new Error(`unexpected dependency: ${name}`);
    };

    assert.strictEqual(plugin._providers.length, 0);
    // onSessionIdChange() no longer awaits its own fetch (fire-and-forget -
    // see the module doc-comment and the "resolves without waiting" test
    // below), so explicitly let it settle before asserting on its result.
    plugin.onSessionIdChange();
    await flushMicrotasks();
    assert.deepStrictEqual(plugin._providers, providers);
  });

  it('resolves without waiting for a slow/pending provider fetch', async () => {
    const plugin = makePlugin();
    /** @type {(value: Array<object>) => void} */
    let resolveFetch;
    const pending = new Promise((resolve) => { resolveFetch = resolve; });
    plugin.getDependency = (name) => {
      if (name === 'client') return { apiClient: { llmProviders: () => pending } };
      throw new Error(`unexpected dependency: ${name}`);
    };

    // onSessionIdChange() must not be an async function that awaits its
    // own fetch - it fires the refresh but returns immediately, even
    // though the mocked fetch never settles within this call.
    const result = plugin.onSessionIdChange();
    assert.strictEqual(result, undefined, 'expected a synchronous (non-Promise) return, not an awaited fetch');

    assert.strictEqual(plugin._providers.length, 0); // fetch still pending
    assert.ok(plugin._refreshPromise, 'expected the fire-and-forget refresh to still be in flight');

    // Clean up: resolve the pending fetch so it doesn't leak into other tests.
    resolveFetch([]);
    await plugin._refreshPromise;
  });
});

describe('InferenceSettingsPlugin.start', () => {
  it('adds a "Default Model" item to the Tools menu under the "inference" category', async () => {
    const plugin = makePlugin();
    let addedItems, addedCategory;
    const providers = [{
      id: 'kisski', label: 'KISSKI',
      models: [{ id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null }]
    }];
    plugin.getDependency = (name) => {
      if (name === 'tools') return { addMenuItems: (items, category) => { addedItems = items; addedCategory = category; } };
      if (name === 'client') return { apiClient: { llmProviders: async () => providers } };
      throw new Error(`unexpected dependency: ${name}`);
    };

    await plugin.start();
    // start() no longer awaits its own fetch (fire-and-forget - see the
    // module doc-comment on startup-blocking), so explicitly let it settle
    // before asserting on its result.
    await flushMicrotasks();

    assert.strictEqual(addedCategory, 'inference');
    assert.strictEqual(addedItems.length, 1);
    // Not addedItems[0].textContent - by the time the refresh resolves,
    // _populateSubmenu() has already populated the submenu, and
    // textContent aggregates ALL descendant text (the submenu's provider
    // labels and model names too). The item's own label is its first
    // child text node, set before the (then-empty) submenu was appended.
    assert.strictEqual(addedItems[0].childNodes[0].textContent, 'Default Model');
    assert.strictEqual(plugin._providers.length, 1);
  });

  it('selecting a model through the built submenu persists it', async () => {
    const plugin = makePlugin();
    let addedItems;
    const providers = [{
      id: 'kisski', label: 'KISSKI',
      models: [{ id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null }]
    }];
    plugin.getDependency = (name) => {
      if (name === 'tools') return { addMenuItems: (items) => { addedItems = items; } };
      if (name === 'client') return { apiClient: { llmProviders: async () => providers } };
      throw new Error(`unexpected dependency: ${name}`);
    };

    await plugin.start();
    // See the comment in the previous test - wait for the fire-and-forget
    // refresh to complete so the submenu actually has a model item built.
    await flushMicrotasks();
    const submenu = addedItems[0].querySelector('sl-menu');
    const modelItem = submenu.querySelector('sl-menu-item');
    submenu.dispatchEvent(new dom.window.CustomEvent('sl-select', { detail: { item: modelItem } }));

    assert.deepStrictEqual(plugin.getDefaultModel(), { providerId: 'kisski', modelId: 'gemma-3' });
  });

  it('resolves without waiting for a slow/pending provider fetch', async () => {
    const plugin = makePlugin();
    let addedItems;
    /** @type {(value: Array<object>) => void} */
    let resolveFetch;
    const pending = new Promise((resolve) => { resolveFetch = resolve; });
    plugin.getDependency = (name) => {
      if (name === 'tools') return { addMenuItems: (items) => { addedItems = items; } };
      if (name === 'client') return { apiClient: { llmProviders: () => pending } };
      throw new Error(`unexpected dependency: ${name}`);
    };

    // start() must resolve even though the mocked fetch never settles
    // within this call - it fires the refresh but does not await it.
    await plugin.start();

    assert.strictEqual(addedItems.length, 1);
    assert.strictEqual(plugin._providers.length, 0); // fetch still pending
    assert.ok(plugin._refreshPromise, 'expected the fire-and-forget refresh to still be in flight');

    // Clean up: resolve the pending fetch so it doesn't leak into other tests.
    resolveFetch([]);
    await plugin._refreshPromise;
  });

  it('re-fetches on mouseenter over the parent menu item', async () => {
    const plugin = makePlugin();
    let addedItems;
    let callCount = 0;
    const providers = [{
      id: 'kisski', label: 'KISSKI',
      models: [{ id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null }]
    }];
    plugin.getDependency = (name) => {
      if (name === 'tools') return { addMenuItems: (items) => { addedItems = items; } };
      if (name === 'client') {
        return { apiClient: { llmProviders: async () => { callCount++; return providers; } } };
      }
      throw new Error(`unexpected dependency: ${name}`);
    };

    await plugin.start();
    await flushMicrotasks(); // let the start()-triggered fetch settle
    assert.strictEqual(callCount, 1);

    addedItems[0].dispatchEvent(new dom.window.Event('mouseenter'));
    await flushMicrotasks(); // let the mouseenter-triggered fetch settle

    assert.strictEqual(callCount, 2);
  });

  it('hides the parent menu item when the fetch returns no providers', async () => {
    const plugin = makePlugin();
    let addedItems;
    plugin.getDependency = (name) => {
      if (name === 'tools') return { addMenuItems: (items) => { addedItems = items; } };
      if (name === 'client') return { apiClient: { llmProviders: async () => [] } };
      throw new Error(`unexpected dependency: ${name}`);
    };

    await plugin.start();
    await flushMicrotasks();

    assert.strictEqual(addedItems[0].style.display, 'none');
  });

  it('shows the parent menu item when the fetch returns at least one provider', async () => {
    const plugin = makePlugin();
    let addedItems;
    const providers = [{
      id: 'kisski', label: 'KISSKI',
      models: [{ id: 'gemma-3', label: 'Gemma 3', capabilities: ['chat'], status: null }]
    }];
    plugin.getDependency = (name) => {
      if (name === 'tools') return { addMenuItems: (items) => { addedItems = items; } };
      if (name === 'client') return { apiClient: { llmProviders: async () => providers } };
      throw new Error(`unexpected dependency: ${name}`);
    };

    await plugin.start();
    await flushMicrotasks();

    assert.strictEqual(addedItems[0].style.display, '');
  });
});
