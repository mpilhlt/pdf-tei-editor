# UI Storage Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a generic `UIStorage` system for persisting UI preferences to `localStorage`, expose it via the plugin API, wire it to the split pane, migrate all existing ad-hoc localStorage/sessionStorage preference calls, and document the system.

**Architecture:** A `UIStorage` class (wrapping `localStorage`) lives in `app/src/modules/`. `PluginContext` gains a `getUIStorage(namespace)` factory; `Plugin` base class gains a lazy `uiStorage` getter. A new `LayoutPlugin` owns global layout state (split panel position). Existing ad-hoc `localStorage` and `SessionStorage.setGlobal` calls for UI preferences are migrated to `this.uiStorage`.

**Tech Stack:** Vanilla JS (ES modules), Node.js `node:test` for unit tests, `localStorage` as storage backend.

---

## File Map

| Action | File | Responsibility |
| --- | --- | --- |
| Create | `app/src/modules/ui-storage.js` | `UIStorage` class |
| Create | `tests/unit/js/ui-storage.test.js` | Unit tests for `UIStorage` |
| Modify | `app/src/modules/plugin-context.js` | Add `getUIStorage(namespace)` factory |
| Modify | `app/src/modules/plugin-base.js` | Add `uiStorage` lazy getter |
| Create | `app/src/plugins/layout.js` | `LayoutPlugin` — split panel persistence |
| Run | `node bin/build.js --steps=plugins` | Regenerate `app/src/plugin-registry.js` |
| Modify | `app/src/plugins.js` | Import and register `LayoutPlugin` |
| Modify | `app/src/plugins/tei-tools.js` | Migrate module-level localStorage helpers |
| Modify | `app/src/plugins/xmleditor.js` | Migrate `#getLineWrappingPreference`, `#getXpathPreference` |
| Modify | `app/src/plugins/pdfviewer.js` | Migrate `SessionStorage.setGlobal` for `handTool` / `autosearch` |
| Create | `docs/code-assistant/ui-storage.md` | Developer guide for `UIStorage` |
| Modify | `CLAUDE.md` | Add `ui-storage.md` to documentation table |
| Modify | `app/CLAUDE.md` | Add UIStorage note to Utilities section |

---

## Task 1: Create `UIStorage` class

**Files:**
- Create: `app/src/modules/ui-storage.js`
- Create: `tests/unit/js/ui-storage.test.js`

- [ ] **Step 1.1: Write failing tests**

Create `tests/unit/js/ui-storage.test.js`:

```js
/**
 * Unit tests for UIStorage
 * @testCovers app/src/modules/ui-storage.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// Minimal localStorage stub
function makeStorage() {
  const data = {};
  return {
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => { data[k] = v; },
    removeItem: (k) => { delete data[k]; },
    _data: data,
  };
}

// Minimal EventTarget stub
function makeElement(initialProps = {}) {
  const handlers = {};
  return {
    ...initialProps,
    addEventListener: (event, fn) => { handlers[event] = fn; },
    removeEventListener: (event, fn) => { if (handlers[event] === fn) delete handlers[event]; },
    _emit: (event) => handlers[event]?.(),
    _handlers: handlers,
  };
}

// Import after mocking (dynamic import to allow for the module to be tested)
const { UIStorage } = await import('../../../app/src/modules/ui-storage.js');

describe('UIStorage', () => {
  let storage;
  let ui;

  beforeEach(() => {
    storage = makeStorage();
    ui = new UIStorage('myplugin', storage);
  });

  describe('get / set / remove', () => {
    it('returns defaultValue when key is absent', () => {
      assert.strictEqual(ui.get('foo', 42), 42);
    });

    it('returns undefined when no default given and key absent', () => {
      assert.strictEqual(ui.get('foo'), undefined);
    });

    it('stores and retrieves a string', () => {
      ui.set('foo', 'bar');
      assert.strictEqual(ui.get('foo'), 'bar');
    });

    it('stores and retrieves a boolean', () => {
      ui.set('flag', true);
      assert.strictEqual(ui.get('flag'), true);
    });

    it('stores and retrieves a number', () => {
      ui.set('pos', 42.5);
      assert.strictEqual(ui.get('pos'), 42.5);
    });

    it('namespaces keys as ui.<namespace>.<key>', () => {
      ui.set('mykey', 'val');
      assert.strictEqual(storage._data['ui.myplugin.mykey'], '"val"');
    });

    it('remove deletes the key', () => {
      ui.set('foo', 1);
      ui.remove('foo');
      assert.strictEqual(ui.get('foo'), undefined);
    });

    it('returns raw string if value is not valid JSON (legacy compat)', () => {
      storage.setItem('ui.myplugin.legacy', 'not-json-{');
      assert.strictEqual(ui.get('legacy'), 'not-json-{');
    });
  });

  describe('bind()', () => {
    it('restores stored value to element property on bind', () => {
      ui.set('pos', 75);
      const el = makeElement({ position: 50 });
      ui.bind(el, 'position', { key: 'pos', event: 'sl-reposition', default: 50 });
      assert.strictEqual(el.position, 75);
    });

    it('uses default value when nothing stored', () => {
      const el = makeElement({ position: 0 });
      ui.bind(el, 'position', { key: 'pos', event: 'sl-reposition', default: 33 });
      assert.strictEqual(el.position, 33);
    });

    it('saves element property to storage on event', () => {
      const el = makeElement({ position: 50 });
      ui.bind(el, 'position', { key: 'pos', event: 'sl-reposition', default: 50 });
      el.position = 70;
      el._emit('sl-reposition');
      assert.strictEqual(ui.get('pos'), 70);
    });

    it('returns unbind function that stops saving', () => {
      const el = makeElement({ position: 50 });
      const unbind = ui.bind(el, 'position', { key: 'pos', event: 'sl-reposition', default: 50 });
      unbind();
      el.position = 99;
      el._emit('sl-reposition');
      assert.strictEqual(ui.get('pos', 50), 50); // unchanged
    });
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
node tests/unit-test-runner.js tests/unit/js/ui-storage.test.js
```

Expected: error — `Cannot find module '../../../app/src/modules/ui-storage.js'`

- [ ] **Step 1.3: Create `UIStorage` implementation**

Create `app/src/modules/ui-storage.js`:

```js
/**
 * UIStorage — persistent key-value store for UI preferences.
 *
 * Wraps localStorage with a namespaced key scheme and optional DOM binding.
 * Use from plugins via `this.uiStorage` (provided by Plugin base class).
 */
export class UIStorage {
  /**
   * @param {string} namespace - Plugin or feature name (e.g. 'xmleditor', 'layout')
   * @param {Storage} [storage] - Storage backend; defaults to localStorage. Injectable for testing.
   */
  constructor(namespace, storage = localStorage) {
    this._namespace = namespace;
    this._storage = storage;
  }

  /**
   * @param {string} key
   * @returns {string}
   */
  _key(key) {
    return `ui.${this._namespace}.${key}`;
  }

  /**
   * Read a persisted value.
   * @param {string} key
   * @param {*} [defaultValue] - Returned when the key is absent.
   * @returns {*}
   */
  get(key, defaultValue = undefined) {
    const raw = this._storage.getItem(this._key(key));
    if (raw === null) return defaultValue;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  /**
   * Persist a value. Values are JSON-serialized.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    this._storage.setItem(this._key(key), JSON.stringify(value));
  }

  /**
   * Remove a persisted value.
   * @param {string} key
   */
  remove(key) {
    this._storage.removeItem(this._key(key));
  }

  /**
   * Bind an element property to a persisted key.
   *
   * On call: restores the stored value (or `default`) to `element[property]`.
   * On `event`: saves the current `element[property]` to storage.
   *
   * @param {EventTarget & Record<string, any>} element - DOM element to bind
   * @param {string} property - Element property name (e.g. 'position', 'checked')
   * @param {object} options
   * @param {string} options.key - Storage key within this namespace
   * @param {string} options.event - DOM event that signals a value change (e.g. 'sl-reposition')
   * @param {*} [options.default] - Value to use when nothing is stored yet
   * @returns {() => void} Unbind function — call to remove the event listener
   */
  bind(element, property, { key, event, default: defaultValue } = {}) {
    const stored = this.get(key, defaultValue);
    if (stored !== undefined) element[property] = stored;
    const handler = () => this.set(key, element[property]);
    element.addEventListener(event, handler);
    return () => element.removeEventListener(event, handler);
  }
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
node tests/unit-test-runner.js tests/unit/js/ui-storage.test.js
```

Expected: all tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add app/src/modules/ui-storage.js tests/unit/js/ui-storage.test.js
git commit -m "feat: add UIStorage class for persistent UI preferences"
```

---

## Task 2: Integrate `UIStorage` into `PluginContext` and `Plugin`

**Files:**
- Modify: `app/src/modules/plugin-context.js`
- Modify: `app/src/modules/plugin-base.js`
- Create: `tests/unit/js/ui-storage-plugin-integration.test.js`

- [ ] **Step 2.1: Write failing test**

Create `tests/unit/js/ui-storage-plugin-integration.test.js`:

```js
/**
 * Integration tests: UIStorage access via PluginContext and Plugin base class.
 * @testCovers app/src/modules/plugin-context.js
 * @testCovers app/src/modules/plugin-base.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// Suppress window.addEventListener call from Application constructor
// @ts-ignore
global.window = { addEventListener: () => {} };

import { UIStorage } from '../../../app/src/modules/ui-storage.js';
import PluginManager from '../../../app/src/modules/plugin-manager.js';
import StateManager from '../../../app/src/modules/state-manager.js';
import { Application } from '../../../app/src/modules/application.js';
import { Plugin } from '../../../app/src/modules/plugin-base.js';

function makeApp() {
  const pm = new PluginManager();
  const sm = new StateManager();
  return new Application(pm, sm);
}

describe('PluginContext.getUIStorage()', () => {
  it('returns a UIStorage instance with the given namespace', () => {
    const app = makeApp();
    const ctx = app.getPluginContext();
    const store = ctx.getUIStorage('myplugin');
    assert.ok(store instanceof UIStorage);
  });

  it('namespaces keys correctly', () => {
    const app = makeApp();
    const ctx = app.getPluginContext();
    const store = ctx.getUIStorage('myplugin');
    assert.strictEqual(store._namespace, 'myplugin');
  });
});

describe('Plugin.uiStorage getter', () => {
  it('returns UIStorage namespaced to plugin name', () => {
    const app = makeApp();
    const ctx = app.getPluginContext();

    class TestPlugin extends Plugin {
      constructor(c) { super(c, { name: 'testplugin' }); }
    }
    const plugin = new TestPlugin(ctx);

    assert.ok(plugin.uiStorage instanceof UIStorage);
    assert.strictEqual(plugin.uiStorage._namespace, 'testplugin');
  });

  it('returns the same instance on repeated access (lazy singleton)', () => {
    const app = makeApp();
    const ctx = app.getPluginContext();

    class TestPlugin extends Plugin {
      constructor(c) { super(c, { name: 'testplugin' }); }
    }
    const plugin = new TestPlugin(ctx);
    assert.strictEqual(plugin.uiStorage, plugin.uiStorage);
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

```bash
node tests/unit-test-runner.js tests/unit/js/ui-storage-plugin-integration.test.js
```

Expected: fails — `ctx.getUIStorage is not a function`

- [ ] **Step 2.3: Add `getUIStorage()` to `PluginContext`**

In `app/src/modules/plugin-context.js`, add this import at the top (after existing imports):

```js
import { UIStorage } from './ui-storage.js';
```

Then add this method to the `PluginContext` class, after the `getDependency` method:

```js
  /**
   * Create a UIStorage instance scoped to the given namespace.
   * Override this method to swap the storage backend (e.g. for testing or server-backed storage).
   * @param {string} namespace - Storage namespace, typically the plugin name
   * @returns {UIStorage}
   */
  getUIStorage(namespace) {
    return new UIStorage(namespace);
  }
```

- [ ] **Step 2.4: Add `uiStorage` getter to `Plugin` base class**

In `app/src/modules/plugin-base.js`, add this import at the top (after existing imports):

```js
import { UIStorage } from './ui-storage.js';
```

In the `Plugin` class, add the private field after the existing `#state` field declaration:

```js
  /** @type {UIStorage|undefined} */
  #uiStorage;
```

Then add the getter after the `get state()` getter:

```js
  /**
   * UIStorage instance scoped to this plugin's name.
   * Use for persisting UI preferences to localStorage across page loads.
   * @returns {UIStorage}
   */
  get uiStorage() {
    if (!this.#uiStorage) this.#uiStorage = this.context.getUIStorage(this.name);
    return this.#uiStorage;
  }
```

- [ ] **Step 2.5: Run tests to verify they pass**

```bash
node tests/unit-test-runner.js tests/unit/js/ui-storage-plugin-integration.test.js
```

Expected: all tests pass.

- [ ] **Step 2.6: Run existing plugin-manager tests to confirm no regressions**

```bash
node tests/unit-test-runner.js tests/unit/js/plugin-manager.test.js tests/unit/js/application.test.js
```

Expected: all pass.

- [ ] **Step 2.7: Commit**

```bash
git add app/src/modules/plugin-context.js app/src/modules/plugin-base.js tests/unit/js/ui-storage-plugin-integration.test.js
git commit -m "feat: expose UIStorage via PluginContext and Plugin base class"
```

---

## Task 3: Create `LayoutPlugin` and register it

**Files:**
- Create: `app/src/plugins/layout.js`
- Run: `node bin/build.js --steps=plugins` (regenerates `app/src/plugin-registry.js`)
- Modify: `app/src/plugins.js`

- [ ] **Step 3.1: Create `app/src/plugins/layout.js`**

```js
/**
 * LayoutPlugin — persists global layout UI state.
 *
 * Owns UI elements in index.html that are not managed by any other plugin.
 * Currently persists: split panel divider position.
 *
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 */

import { Plugin } from '../modules/plugin-base.js';

class LayoutPlugin extends Plugin {
  /** @param {PluginContext} context */
  constructor(context) {
    super(context, { name: 'layout' });
  }

  /**
   * @param {ApplicationState} initialState
   */
  async install(initialState) {
    await super.install(initialState);
    const panel = document.querySelector('#editors');
    if (panel) {
      this.uiStorage.bind(panel, 'position', {
        key: 'splitPosition',
        event: 'sl-reposition',
        default: 50,
      });
    }
  }
}

export default LayoutPlugin;
```

- [ ] **Step 3.2: Regenerate plugin registry**

```bash
node bin/build.js --steps=plugins
```

Expected output includes: `Generated app/src/plugin-registry.js (35 plugins, 35 re-exports)`

Verify `LayoutPlugin` appears in `app/src/plugin-registry.js`:

```bash
grep "LayoutPlugin" app/src/plugin-registry.js
```

Expected: `export { default as LayoutPlugin } from './plugins/layout.js';`

- [ ] **Step 3.3: Add `LayoutPlugin` to `plugins.js`**

In `app/src/plugins.js`, add `LayoutPlugin` to the import block:

```js
import {
  // ... existing imports ...
  LayoutPlugin,
  // ... existing imports ...
} from './plugin-registry.js'
```

Add it near the top of the plugins array (it should run early, before document-specific plugins):

```js
const plugins = [
  // ... existing plugins ...
  LayoutPlugin,
  // ... rest of plugins ...
]
```

Place it with the "Other plugins" group, before `PdfViewerPlugin`.

- [ ] **Step 3.4: Verify the app boots (no console errors)**

Check that the split panel position restores after dragging the divider and reloading the page. This requires a running dev server — if available, drag the split divider, reload, and confirm the position is preserved. If the dev server is not running, skip to the commit step.

- [ ] **Step 3.5: Commit**

```bash
git add app/src/plugins/layout.js app/src/plugin-registry.js app/src/plugins.js
git commit -m "feat: add LayoutPlugin to persist split panel position"
```

---

## Task 4: Migrate `tei-tools.js`

**Files:**
- Modify: `app/src/plugins/tei-tools.js:26-36,144,177`

The two module-level helper functions (`getTeiHeaderVisibilityPreference`, `setTeiHeaderVisibilityPreference`) are replaced by inline `this.uiStorage` calls.

- [ ] **Step 4.1: Remove module-level helper functions**

In `app/src/plugins/tei-tools.js`, delete lines 22–37 (the two helper functions and their JSDoc comments):

```js
/**
 * Get teiHeader visibility preference from localStorage
 * @returns {boolean}
 */
function getTeiHeaderVisibilityPreference() {
  const stored = localStorage.getItem('tei-tools.teiHeaderVisible')
  return stored === 'true'
}

/**
 * Set teiHeader visibility preference in localStorage
 * @param {boolean} visible
 */
function setTeiHeaderVisibilityPreference(visible) {
  localStorage.setItem('tei-tools.teiHeaderVisible', String(visible))
}
```

- [ ] **Step 4.2: Replace call site at line 144**

The line currently reads:
```js
const preferredVisible = getTeiHeaderVisibilityPreference()
```

Replace with:
```js
const preferredVisible = this.uiStorage.get('teiHeaderVisible', false)
```

- [ ] **Step 4.3: Replace call site at line 177**

The line currently reads:
```js
setTeiHeaderVisibilityPreference(show)
```

Replace with:
```js
this.uiStorage.set('teiHeaderVisible', show)
```

- [ ] **Step 4.4: Verify no remaining references**

```bash
grep -n "getTeiHeaderVisibility\|setTeiHeaderVisibility\|tei-tools\.teiHeader" app/src/plugins/tei-tools.js
```

Expected: no output.

- [ ] **Step 4.5: Commit**

```bash
git add app/src/plugins/tei-tools.js
git commit -m "refactor: migrate tei-tools localStorage to UIStorage"
```

---

## Task 5: Migrate `xmleditor.js`

**Files:**
- Modify: `app/src/plugins/xmleditor.js:988-1021`

The three private methods (`#getLineWrappingPreference`, `#setLineWrappingPreference`, `#getXpathPreference`, `#setXpathPreference`) are replaced by `this.uiStorage` calls.

- [ ] **Step 5.1: Replace `#getLineWrappingPreference`**

Current (lines 988–994):
```js
#getLineWrappingPreference() {
  const stored = localStorage.getItem('xmleditor.lineWrapping');
  return stored === null ? true : stored === 'true';
}
```

Replace with:
```js
#getLineWrappingPreference() {
  return this.uiStorage.get('lineWrapping', true);
}
```

- [ ] **Step 5.2: Replace `#setLineWrappingPreference`**

Current (lines 996–1001):
```js
#setLineWrappingPreference(enabled) {
  localStorage.setItem('xmleditor.lineWrapping', String(enabled));
}
```

Replace with:
```js
#setLineWrappingPreference(enabled) {
  this.uiStorage.set('lineWrapping', enabled);
}
```

- [ ] **Step 5.3: Replace `#getXpathPreference`**

Current (lines 1003–1009):
```js
#getXpathPreference(variantId) {
  return localStorage.getItem(`xmleditor.xpath.${variantId}`);
}
```

Replace with:
```js
#getXpathPreference(variantId) {
  return this.uiStorage.get(`xpath.${variantId}`, null);
}
```

- [ ] **Step 5.4: Replace `#setXpathPreference`**

Current (lines 1011–1021):
```js
#setXpathPreference(variantId, xpath) {
  if (xpath) {
    localStorage.setItem(`xmleditor.xpath.${variantId}`, xpath);
  } else {
    localStorage.removeItem(`xmleditor.xpath.${variantId}`);
  }
}
```

Replace with:
```js
#setXpathPreference(variantId, xpath) {
  if (xpath) {
    this.uiStorage.set(`xpath.${variantId}`, xpath);
  } else {
    this.uiStorage.remove(`xpath.${variantId}`);
  }
}
```

- [ ] **Step 5.5: Verify no remaining raw localStorage calls for these keys**

```bash
grep -n "localStorage.*xmleditor\|xmleditor.*lineWrapping\|xmleditor.*xpath" app/src/plugins/xmleditor.js
```

Expected: no output.

- [ ] **Step 5.6: Commit**

```bash
git add app/src/plugins/xmleditor.js
git commit -m "refactor: migrate xmleditor localStorage to UIStorage"
```

---

## Task 6: Migrate `pdfviewer.js`

**Files:**
- Modify: `app/src/plugins/pdfviewer.js:49,268,337,495,503,559`

Only the `getGlobal`/`setGlobal` calls for `handTool` and `autosearch` are migrated — the per-document `setValue`/`getState` calls on `#storage` (scroll position, page, zoom) remain on `SessionStorage` since those are session-scoped, not persistent preferences.

- [ ] **Step 6.1: Replace `autosearch` read in `install()`**

Line 268:
```js
const savedAutoSearch = this.#storage.getGlobal('autosearch', false);
```

Replace with:
```js
const savedAutoSearch = this.uiStorage.get('autosearch', false);
```

- [ ] **Step 6.2: Replace `handTool` read in `install()`**

Line 337:
```js
if (this.#storage.getGlobal('handTool', false)) {
```

Replace with:
```js
if (this.uiStorage.get('handTool', false)) {
```

- [ ] **Step 6.3: Replace `handTool` write in `#onSelectTextTool()`**

Line 495:
```js
this.#storage.setGlobal('handTool', false);
```

Replace with:
```js
this.uiStorage.set('handTool', false);
```

- [ ] **Step 6.4: Replace `handTool` write in `#onSelectHandTool()`**

Line 503:
```js
this.#storage.setGlobal('handTool', true);
```

Replace with:
```js
this.uiStorage.set('handTool', true);
```

- [ ] **Step 6.5: Replace `autosearch` write in `#onAutoSearchSwitchChange()`**

Line 559:
```js
this.#storage.setGlobal('autosearch', checked);
```

Replace with:
```js
this.uiStorage.set('autosearch', checked);
```

- [ ] **Step 6.6: Verify no remaining `getGlobal`/`setGlobal` calls**

```bash
grep -n "getGlobal\|setGlobal" app/src/plugins/pdfviewer.js
```

Expected: no output.

- [ ] **Step 6.7: Commit**

```bash
git add app/src/plugins/pdfviewer.js
git commit -m "refactor: migrate pdfviewer SessionStorage.setGlobal to UIStorage"
```

---

## Task 7: Write documentation and update agent files

**Files:**
- Create: `docs/code-assistant/ui-storage.md`
- Modify: `CLAUDE.md`
- Modify: `app/CLAUDE.md`

- [ ] **Step 7.1: Create `docs/code-assistant/ui-storage.md`**

Write the file with the following content:

````markdown
# UIStorage — UI Preference Persistence

`UIStorage` persists UI preferences to `localStorage` across page loads. Use it for any preference that should survive a browser refresh: toggle states, panel sizes, last-used values.

Do **not** use it for:
- Per-document/per-context state (use `SessionStorage` — `app/src/modules/session-storage.js`)
- Application state shared across plugins (use `app.dispatchStateChange()`)

## Accessing UIStorage in a Plugin

All class-based plugins get a `uiStorage` getter from the `Plugin` base class. It is lazy-initialised and scoped to `this.name`:

```js
// Inside any Plugin subclass install() or method:
const value = this.uiStorage.get('myKey', defaultValue);
this.uiStorage.set('myKey', value);
this.uiStorage.remove('myKey');
```

## Key Naming

Keys are stored in `localStorage` as `ui.<namespace>.<key>`. The namespace is `this.name` automatically. Example: `XmlEditorPlugin` (`name: 'xmleditor'`) calling `this.uiStorage.set('lineWrapping', true)` writes key `ui.xmleditor.lineWrapping`.

Pick short, descriptive keys. Dot-separated sub-keys are fine: `this.uiStorage.set('xpath.header', '//teiHeader')` → `ui.xmleditor.xpath.header`.

## DOM Binding

`bind()` wires a DOM element property to a persisted key — restores the stored value on call and saves on each event:

```js
// In install():
this.uiStorage.bind(someElement, 'propertyName', {
  key: 'myKey',
  event: 'sl-change',   // DOM event that fires when the value changes
  default: false,        // used when nothing is stored yet
});
```

Returns an unbind function. Call it in `shutdown()` if the element may be removed from the DOM:

```js
this.#unbindPref = this.uiStorage.bind(el, 'checked', { key: 'myFlag', event: 'sl-change', default: false });

async shutdown() {
  this.#unbindPref?.();
}
```

### Common Shoelace events

| Component | Property | Event |
| --- | --- | --- |
| `sl-split-panel` | `position` | `sl-reposition` |
| `sl-switch` / `sl-checkbox` | `checked` | `sl-change` |
| `sl-select` | `value` | `sl-change` |
| `sl-range` | `value` | `sl-change` |

## Testing

Inject a storage stub to avoid touching real `localStorage` in tests:

```js
const store = {};
const stub = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = v; },
  removeItem: (k) => { delete store[k]; },
};
const ui = new UIStorage('myplugin', stub);
```

## Swapping the Backend

`PluginContext.getUIStorage(namespace)` creates `UIStorage` instances. Override it in a subclass to replace the storage backend for all plugins at once:

```js
class TestContext extends PluginContext {
  getUIStorage(namespace) {
    return new UIStorage(namespace, myStubStorage);
  }
}
```
````

- [ ] **Step 7.2: Add `ui-storage.md` reference to root `CLAUDE.md`**

In `CLAUDE.md`, find the Detailed Documentation table and add a row after the Frontend Architecture entry:

```markdown
- **[UI Storage](docs/code-assistant/ui-storage.md)** - Persisting UI preferences (split pane, toggles) with `UIStorage` and DOM binding
```

- [ ] **Step 7.3: Add UIStorage note to `app/CLAUDE.md`**

In `app/CLAUDE.md`, find the `## Utilities` section and add before the first utility item:

```markdown
- **UI preferences** — Use `this.uiStorage` (from `Plugin` base class) to persist UI preferences to `localStorage`. Never call `localStorage.getItem/setItem` directly — always go through `UIStorage`. See [docs/code-assistant/ui-storage.md](../docs/code-assistant/ui-storage.md) for the full API and DOM binding pattern.
```

- [ ] **Step 7.4: Commit**

```bash
git add docs/code-assistant/ui-storage.md CLAUDE.md app/CLAUDE.md
git commit -m "docs: add UIStorage developer guide and agent file references"
```

---

## Task 8: Create GitHub issue for HTML attribute binding (Approach C)

- [ ] **Step 8.1: Create the issue**

```bash
gh issue create \
  --title "feat: HTML attribute binding for UIStorage (Approach C)" \
  --label "frontend" \
  --body "$(cat <<'EOF'
## Background

Issue #368 introduced `UIStorage` with imperative DOM binding via `uiStorage.bind()` (Approach A).

## Feature Request

Add HTML attribute-based binding (Approach C) as a declarative layer on top of `UIStorage.bind()`.

### Proposed markup

\`\`\`html
<sl-split-panel id="editors" ui-persist="position" ui-persist-event="sl-reposition" ui-persist-default="50">
\`\`\`

### Proposed attributes

| Attribute | Description |
| --- | --- |
| \`ui-persist\` | Element property name to persist |
| \`ui-persist-key\` | Storage key override (defaults to element \`id\` or \`name\`) |
| \`ui-persist-event\` | DOM event that triggers a save |
| \`ui-persist-default\` | Default value if nothing stored |
| \`ui-persist-ns\` | Namespace override (defaults to \`app\`) |

### Implementation sketch

A boot-time scanner in \`LayoutPlugin.install()\` or \`app.js\` reads all \`[ui-persist]\` elements and calls \`uiStorage.bind()\` for each. No changes needed to the \`UIStorage\` class itself.

## Acceptance criteria

- [ ] Elements with \`ui-persist\` attribute are auto-bound at boot
- [ ] Works for elements in \`index.html\` and in plugin templates
- [ ] Dynamically added elements are NOT auto-bound (out of scope; can be added later)
- [ ] Existing imperative \`uiStorage.bind()\` calls continue to work unchanged
EOF
)"
```

---

## Completion Checklist

- [ ] All unit tests pass: `node tests/unit-test-runner.js tests/unit/js/ui-storage.test.js tests/unit/js/ui-storage-plugin-integration.test.js`
- [ ] All existing unit tests still pass: `node tests/unit-test-runner.js tests/unit/js/`
- [ ] Split panel position persists across page reloads
- [ ] `tei-tools` header visibility persists across page reloads
- [ ] `xmleditor` line wrapping and xpath preferences persist across page reloads
- [ ] PDF viewer hand tool and autosearch preferences persist across page reloads
- [ ] GitHub issue for Approach C created
