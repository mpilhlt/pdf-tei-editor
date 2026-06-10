# UI State Persistence Design

**Date:** 2026-06-10
**Issue:** #368
**Status:** Approved

## Problem

UI preferences (split pane position, line wrapping toggle, XPath variants, PDF viewer tool state) are currently persisted in an ad-hoc, inconsistent way:

- Some use `localStorage` directly with manual key strings (`tei-tools.teiHeaderVisible`, `xmleditor.lineWrapping`)
- Some use `SessionStorage.setGlobal` which uses `sessionStorage` — these are lost on page close
- No uniform API, no testability, no swappable backend

## Solution

A `UIStorage` class that wraps `localStorage` with namespaced keys, DOM binding, and injectable storage for testing. Exposed via `PluginContext` so the implementation can be swapped. Global UI state (layout) is owned by a new `LayoutPlugin`.

---

## 1. `UIStorage` class

**File:** `app/src/modules/ui-storage.js`

```js
export class UIStorage {
  constructor(namespace, storage = localStorage) { ... }

  get(key, defaultValue)   // JSON-parsed read; returns defaultValue if absent
  set(key, value)          // JSON-serialized write
  remove(key)              // remove a single key
  bind(element, property, { key, event, default })  // DOM binding; returns unbind fn
}
```

**Key format:** `ui.<namespace>.<key>` — e.g. `ui.xmleditor.lineWrapping`, `ui.layout.splitPosition`.

**`bind()` contract:**

1. On call: reads stored value and assigns `element[property]` if present (or `default` if not yet stored).
2. Attaches `event` listener: on every event, writes `element[property]` to storage.
3. Returns an unbind function that removes the listener.

**`storage` injection:** Defaults to `window.localStorage`. Pass any `{ getItem, setItem, removeItem }` object for tests or to swap to a server-backed implementation later.

---

## 2. Plugin API integration

### `PluginContext`

New method:

```js
getUIStorage(namespace) {
  return new UIStorage(namespace);
}
```

This is the single place where the storage implementation can be changed (e.g. swapped to a server-backed store, or overridden in tests).

### `Plugin` base class

New private field and lazy getter:

```js
/** @type {UIStorage|undefined} */
#uiStorage;

get uiStorage() {
  if (!this.#uiStorage) this.#uiStorage = this.context.getUIStorage(this.name);
  return this.#uiStorage;
}
```

Namespace is `this.name`, which matches the plugin's existing identity (e.g. `xmleditor`, `pdfviewer`).

Usage in any plugin:

```js
async install(initialState) {
  await super.install(initialState);
  this.uiStorage.bind(someElement, 'property', {
    key: 'myKey',
    event: 'sl-change',
    default: false,
  });
}
```

---

## 3. `LayoutPlugin`

**File:** `app/src/plugins/layout.js`

A new plugin that owns global layout UI state — elements in `index.html` that are not owned by any other plugin. Initially it persists the split panel divider position; it is the natural home for future global layout preferences.

```js
export class LayoutPlugin extends Plugin {
  constructor(context) {
    super(context, { name: 'layout' });
  }

  async install(initialState) {
    await super.install(initialState);
    const panel = document.querySelector('#editors');
    this.uiStorage.bind(panel, 'position', {
      key: 'splitPosition',
      event: 'sl-reposition',
      default: 50,
    });
  }
}
```

Registration: added to `plugin-registry.js` and `plugins.js` alongside existing plugins.

Namespace used in storage: `layout` (`this.name` set explicitly in constructor — without it the default would be `layoutplugin`).

---

## 4. Migration of existing ad-hoc uses

All existing direct `localStorage`/`sessionStorage` uses for UI preferences are replaced with `this.uiStorage`. Storage keys are preserved where migration would be transparent (same `ui.<namespace>.<key>` format), or noted where the old key differs.

| Plugin | Old mechanism | Old key | New call |
| --- | --- | --- | --- |
| `tei-tools.js` | `localStorage` | `tei-tools.teiHeaderVisible` | `this.uiStorage.get/set('teiHeaderVisible')` |
| `xmleditor.js` | `localStorage` | `xmleditor.lineWrapping` | `this.uiStorage.get/set('lineWrapping')` |
| `xmleditor.js` | `localStorage` | `xmleditor.xpath.${variantId}` | `this.uiStorage.get/set('xpath.${variantId}')` |
| `pdfviewer.js` | `SessionStorage.getGlobal/setGlobal` | `handTool` | `this.uiStorage.get/set('handTool')` |
| `pdfviewer.js` | `SessionStorage.getGlobal/setGlobal` | `autosearch` | `this.uiStorage.get/set('autosearch')` |

**Note on key migration:** Old localStorage keys like `tei-tools.teiHeaderVisible` differ from the new `ui.teitools.teiHeaderVisible` format, so existing stored values are not automatically read. This is acceptable — preferences reset once on first run after the migration, then persist normally.

---

## 5. Out of scope / future

- **Approach C (HTML attribute binding):** Declare bindings in markup via `ui-persist` attributes, processed at boot. Track in a separate GitHub issue; can be layered on top of the `UIStorage.bind()` primitive without changes to this design.
- **Server-backed storage:** Swap the `localStorage` backend in `PluginContext.getUIStorage()` to sync across devices. No API changes needed in plugins.
- **`SessionStorage` global state:** The remaining `SessionStorage.setGlobal` uses that are truly session-scoped (not UI preferences) stay as-is.
