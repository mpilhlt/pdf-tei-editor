# Inference Settings Plugin (Default LLM Model Picker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `app/src/plugins/inference-settings.js`, a new core frontend plugin exposing a shared, persisted "default LLM model" (`getDefaultModel()`/`setDefaultModel()`) that any LLM-consuming plugin can read and fall back to, with a Tools-menu "Default Model" picker (new "inference" category) showing every available provider's models with a busy-warning icon.

**Architecture:** A single core `Plugin` subclass (`deps: ['client', 'tools']`) that (1) fetches `GET /api/v1/llm/providers` via `getDependency('client').apiClient.llmProviders()` (already generated, Plan 1), (2) builds a nested Tools-menu submenu (`sl-menu-item` "Default Model" → `sl-menu[slot=submenu]` → per-provider `<small>` label + `sl-menu-item[type=checkbox]` per model), and (3) persists the selection via `this.uiStorage` (`ui.inference-settings.defaultModel`). Two deliberate deviations from the design doc's illustrative sketch, both toward patterns already proven elsewhere in this codebase rather than untested pseudo-code:

- **Selection handling** uses the exact single-select-via-checkbox pattern already working in `app/src/plugins/xmleditor.js:352-361` (one `sl-select` listener on the containing `<sl-menu>`, manual `.checked` toggling across siblings) instead of the design doc's per-item `click` listener sketch — same observable behavior, reuses a pattern already exercised in production.
- **"Refresh on next submenu open"** (design doc, Part F "Error handling") is implemented as a `mouseenter` listener on the parent "Default Model" item rather than an `sl-show`/`sl-hide` event on the submenu itself — Shoelace's nested-submenu support (`node_modules/@shoelace-style/shoelace/dist/components/menu-item/submenu-controller.d.ts`) manages hover/focus internally and does not dispatch a public open/close event, confirmed by inspecting the installed package. `mouseenter` fires right as the user is about to open the submenu, giving the same self-correcting effect using a standard DOM event instead of relying on an unverified internal Shoelace event.

**Tech Stack:** JavaScript (ES modules), Shoelace web components (`sl-menu`, `sl-menu-item`, `sl-tooltip`, `sl-icon`), Node's built-in test runner (`node:test`) + `jsdom` (project convention for DOM-dependent frontend unit tests, see `tests/unit/js/xmleditor-readonly-theme.test.js`).

**Design reference:** [docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md](../specs/2026-09-24-llm-annotation-review-design.md) (Part F). Depends on Part A's `GET /api/v1/llm/providers` route and `app/src/modules/api-client-v1.js`'s `llmProviders()` method, both already implemented and merged (`docs/superpowers/plans/2026-09-24-llm-provider-registry.md`, commit `10f84500`).

---

## File Structure

- Create `app/src/plugins/inference-settings.js` — `InferenceSettingsPlugin` class: `getDefaultModel()`/`setDefaultModel()`, Tools-menu submenu construction, provider fetch.
- Create `tests/unit/js/inference-settings.test.js` — all unit tests for the plugin (built up incrementally, one `describe` block per task).
- Modify `app/src/plugin-registry.js` — add the new plugin's export.
- Modify `app/src/plugins.js` — import and register the plugin in the `plugins` array.

All new/changed JS files use `node:test`'s `describe`/`it`, matching every existing file in `tests/unit/js/` — this project does not use a separate test framework (Jest, Mocha, etc.) for JS unit tests.

---

### Task 1: Plugin skeleton + `getDefaultModel()`/`setDefaultModel()`

**Files:**
- Create: `app/src/plugins/inference-settings.js`
- Test: `tests/unit/js/inference-settings.test.js`

- [ ] **Step 1: Write the failing test**

```js
#!/usr/bin/env node

/**
 * Unit tests for the inference-settings plugin (shared default LLM model).
 * @testCovers app/src/plugins/inference-settings.js
 */

import { describe, it, beforeEach } from 'node:test';
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/unit-test-runner.js tests/unit/js/inference-settings.test.js`
Expected: FAIL with `Cannot find module '.../app/src/plugins/inference-settings.js'`

- [ ] **Step 3: Write the implementation**

```js
/**
 * Inference Settings Plugin
 *
 * Generic core plugin exposing a shared "default LLM model" that any
 * LLM-consuming plugin can read via getDefaultModel() and fall back to
 * unless it has its own explicit per-call override. Adds a "Default Model"
 * entry to the Tools menu (new "inference" category) listing every
 * available provider's models, fetched from GET /api/v1/llm/providers,
 * with a warning icon when a model's live status isn't "available".
 *
 * See docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md
 * (Part F) for the design rationale.
 */

import { Plugin } from '../modules/plugin-base.js';

/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ProviderResponse } from '../modules/api-client-v1.js'
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
   * The currently selected default model, or null if nothing has been
   * selected yet, or the stored value no longer matches an available
   * provider/model in the last successful fetch (_providers).
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
    if (!this._submenu) return;
    this._submenu.querySelectorAll('sl-menu-item').forEach(el => {
      /** @type {HTMLElement & {checked: boolean}} */ (el).checked =
        el.dataset.providerId === providerId && el.dataset.modelId === modelId;
    });
  }
}

export default InferenceSettingsPlugin;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/unit-test-runner.js tests/unit/js/inference-settings.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add app/src/plugins/inference-settings.js tests/unit/js/inference-settings.test.js
git commit -m "$(cat <<'EOF'
feat(inference-settings): add plugin skeleton + default-model persistence

First piece of the default-model picker (Part F of the 2026-09-24
annotation-review design) - getDefaultModel()/setDefaultModel() over
UIStorage, with "stored default no longer available" validated against
the last fetched provider list.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Submenu/model-item DOM builders + busy-warning tooltip

**Files:**
- Modify: `app/src/plugins/inference-settings.js`
- Modify: `tests/unit/js/inference-settings.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/js/inference-settings.test.js`:

```js
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
    assert.match(tooltip.content, /currently busy/);
    assert.match(tooltip.content, /demand: 3/);
    const icon = tooltip.querySelector('sl-icon');
    assert.ok(icon, 'expected an sl-icon inside the tooltip');
    assert.strictEqual(icon.name, 'exclamation-triangle');
    assert.strictEqual(icon.slot, 'suffix');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/unit-test-runner.js tests/unit/js/inference-settings.test.js`
Expected: FAIL — `plugin._buildModelItem is not a function`

- [ ] **Step 3: Write the implementation**

Add these imports to the top `@import` block of `app/src/plugins/inference-settings.js` (alongside the existing `PluginContext`/`ProviderResponse` line):

```js
/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ProviderResponse, ModelResponse } from '../modules/api-client-v1.js'
 */
```

Add these two methods to the `InferenceSettingsPlugin` class, after `setDefaultModel`:

```js
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
      const tooltip = /** @type {HTMLElement & {content: string}} */ (document.createElement('sl-tooltip'));
      tooltip.content = `This model is currently ${model.status.availability.replace('_', ' ')}`
        + (model.status.detail ? ` (${model.status.detail})` : '') + ' and may time out.';
      const icon = /** @type {HTMLElement & {name: string}} */ (document.createElement('sl-icon'));
      icon.name = 'exclamation-triangle';
      icon.slot = 'suffix';
      tooltip.appendChild(icon);
      item.appendChild(tooltip);
    }
    return item;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/unit-test-runner.js tests/unit/js/inference-settings.test.js`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add app/src/plugins/inference-settings.js tests/unit/js/inference-settings.test.js
git commit -m "$(cat <<'EOF'
feat(inference-settings): build submenu with busy-warning tooltips

_populateSubmenu()/_buildModelItem() render one <small> provider label
+ one checkbox item per model, with a warning tooltip+icon attached
only when a model's live status isn't "available" - silence (no icon)
when a provider exposes no status at all.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Selection handling (`_onSelect`)

**Files:**
- Modify: `app/src/plugins/inference-settings.js`
- Modify: `tests/unit/js/inference-settings.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/js/inference-settings.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/unit-test-runner.js tests/unit/js/inference-settings.test.js`
Expected: FAIL — `plugin._onSelect is not a function`

- [ ] **Step 3: Write the implementation**

Add this method to the `InferenceSettingsPlugin` class, after `_buildModelItem`:

```js
  /**
   * Handle `sl-select` on the submenu: persist the clicked item's
   * provider/model as the new default. A bare item with no
   * data-provider-id/data-model-id (e.g. a future non-model entry) is
   * ignored rather than persisting an incomplete selection.
   * @param {CustomEvent} event
   */
  _onSelect(event) {
    const item = /** @type {HTMLElement} */ (event.detail.item);
    const { providerId, modelId } = item.dataset;
    if (!providerId || !modelId) return;
    this.setDefaultModel(providerId, modelId);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/unit-test-runner.js tests/unit/js/inference-settings.test.js`
Expected: PASS (19 tests)

- [ ] **Step 5: Commit**

```bash
git add app/src/plugins/inference-settings.js tests/unit/js/inference-settings.test.js
git commit -m "$(cat <<'EOF'
feat(inference-settings): handle submenu selection

_onSelect() reads the clicked item's data-provider-id/data-model-id
and delegates to setDefaultModel(), reusing the single-select-via-
checkbox pattern already proven in xmleditor.js's theme picker.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `start()` + `_refresh()` wiring, plugin registration

**Files:**
- Modify: `app/src/plugins/inference-settings.js`
- Modify: `tests/unit/js/inference-settings.test.js`
- Modify: `app/src/plugin-registry.js`
- Modify: `app/src/plugins.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/js/inference-settings.test.js`:

```js
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

    assert.strictEqual(addedCategory, 'inference');
    assert.strictEqual(addedItems.length, 1);
    // Not addedItems[0].textContent - by the time start() resolves,
    // _refresh() has already populated the submenu, and textContent
    // aggregates ALL descendant text (the submenu's provider labels and
    // model names too). The item's own label is its first child text
    // node, set before the (then-empty) submenu was appended.
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
    const submenu = addedItems[0].querySelector('sl-menu');
    const modelItem = submenu.querySelector('sl-menu-item');
    submenu.dispatchEvent(new dom.window.CustomEvent('sl-select', { detail: { item: modelItem } }));

    assert.deepStrictEqual(plugin.getDefaultModel(), { providerId: 'kisski', modelId: 'gemma-3' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/unit-test-runner.js tests/unit/js/inference-settings.test.js`
Expected: FAIL — `plugin._refresh is not a function`

- [ ] **Step 3: Write the implementation**

Add these two methods to the `InferenceSettingsPlugin` class, replacing nothing (append after `_onSelect`):

```js
  /**
   * Build the "Default Model" Tools-menu item + its submenu, register it,
   * and run the first provider fetch.
   */
  async start() {
    const parentItem = document.createElement('sl-menu-item');
    parentItem.textContent = 'Default Model';

    const submenu = document.createElement('sl-menu');
    submenu.slot = 'submenu';
    parentItem.appendChild(submenu);
    this._submenu = submenu;

    submenu.addEventListener('sl-select', (event) => this._onSelect(/** @type {CustomEvent} */(event)));
    // No public "submenu opened" event exists on sl-menu-item - see the
    // "Refresh on next submenu open" note in this file's module doc-comment.
    parentItem.addEventListener('mouseenter', () => this._refresh());

    this.#tools.addMenuItems([parentItem], 'inference');

    await this._refresh();
  }

  /**
   * Fetch the current provider/model list and rebuild the submenu. On
   * failure, leaves the previous _providers/submenu state untouched
   * (stale data is more useful than an empty menu) and logs a warning -
   * mirrors backend-plugins.js's discoverPlugins() error handling.
   * @returns {Promise<void>}
   */
  async _refresh() {
    /** @type {Array<ProviderResponse>} */
    let providers;
    try {
      providers = await this.#client.apiClient.llmProviders();
    } catch (error) {
      console.warn('inference-settings: could not load LLM providers:', error);
      return;
    }
    this._providers = providers;
    if (this._submenu) {
      this._populateSubmenu(providers);
    }
  }
```

Also update the module doc-comment's "Refresh on next submenu open" rationale is already covered by the plan header — no further doc-comment change needed here.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/unit-test-runner.js tests/unit/js/inference-settings.test.js`
Expected: PASS (23 tests)

- [ ] **Step 5: Register the plugin in `app/src/plugin-registry.js`**

Add, in alphabetical position among the existing `export { default as ... }` lines (after `HelpPlugin`, before `InfoPlugin`):

```js
export { default as InferenceSettingsPlugin } from './plugins/inference-settings.js';
```

- [ ] **Step 6: Register the plugin in `app/src/plugins.js`**

Add `InferenceSettingsPlugin` to the import list from `./plugin-registry.js` (alphabetical position, after `HelpPlugin`, before `InfoPlugin`):

```js
  HelpPlugin,
  InferenceSettingsPlugin,
  InfoPlugin,
```

Add it to the `plugins` array, right after `ToolsPlugin` (its `tools` dependency) and before `PromptEditorPlugin`, with a comment matching the array's existing Tools-menu-category convention:

```js
  ToolsPlugin,
  InferenceSettingsPlugin, // Tools menu — Inference section (default LLM model picker)
  PromptEditorPlugin,
```

- [ ] **Step 7: Verify the plugin registration is well-formed**

Run: `node --check app/src/plugin-registry.js && node --check app/src/plugins.js && echo OK`
Expected: `OK` (syntax-checks both files; a full import isn't possible outside a browser since `plugins.js` transitively imports CodeMirror/DOM-only modules)

- [ ] **Step 8: Commit**

```bash
git add app/src/plugins/inference-settings.js tests/unit/js/inference-settings.test.js app/src/plugin-registry.js app/src/plugins.js
git commit -m "$(cat <<'EOF'
feat(inference-settings): wire start()/_refresh() and register the plugin

start() builds the "Default Model" Tools-menu submenu and runs the
first GET /api/v1/llm/providers fetch; _refresh() re-fetches on
mouseenter (no public submenu-open event exists on sl-menu-item, see
this file's module doc-comment) so a stale busy-status or a since-
removed provider/model self-corrects. Registered into plugins.js after
ToolsPlugin.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Full regression pass + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full JS unit test suite**

Run: `npm run test:unit:js`
Expected: All tests pass, including every test added in this plan plus the full pre-existing suite (no regressions elsewhere in the frontend).

- [ ] **Step 2: Manual verification (not automatable in this plan — record the outcome as a follow-up note, do not skip)**

The design doc flagged two items that can only be confirmed by looking at the real, rendered app (per `CLAUDE.md`, never start/restart the dev server yourself — ask the user to load the app, which is already running via the auto-reloading dev server):

1. Whether `sl-tooltip` wrapping an `sl-icon` renders/positions correctly as a `suffix` inside a nested `sl-menu-item[type=checkbox]` — no existing precedent in this codebase combines a tooltip with a menu-item checkbox.
2. Whether the two-level nesting (Tools → "Default Model" → provider label + checkbox items) opens/closes correctly on hover, and whether the `mouseenter`-triggered re-fetch (Task 4) is perceptible/acceptable UX (e.g. not re-fetching so eagerly it feels laggy).

Ask the user to open the app, go to Tools → (Inference category) → Default Model, and confirm: the submenu opens on hover, provider labels + model checkboxes render, selecting a model checks it and unchecks any previous selection, and (if `KISSKI_API_KEY` is configured) a busy/very-busy model shows the warning tooltip on hover. Record the outcome as a follow-up note in this task's commit message; if either item fails, stop and fix before considering Part F done.

- [ ] **Step 3: No commit needed for this task** — it's a verification checkpoint. If Step 2's manual check passes, Part F (default-model selection plugin) is complete; the next plan (Part C, `annotation_review` backend plugin) can depend on `getDependency('inference-settings').getDefaultModel()`.
