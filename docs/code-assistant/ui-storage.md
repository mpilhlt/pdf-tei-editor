# UI Storage

`UIStorage` is the standard API for persisting UI preferences across browser sessions. Use it whenever you need to remember a user's choice (toggle state, panel position, last-used option) between page loads.

---

## When to use which storage mechanism

| Need | Mechanism |
| --- | --- |
| UI preference that survives page close (line wrapping, panel position) | `UIStorage` (localStorage) |
| Per-document context that resets on page close (scroll position, zoom) | `SessionStorage` (sessionStorage) |
| Shared runtime state visible to multiple plugins | `StateManager` (`this.dispatchStateChange`) |

Never write `localStorage` or `sessionStorage` directly in plugin code. Use the appropriate abstraction.

---

## Accessing UIStorage from a plugin

Every plugin inheriting from `Plugin` gets a `uiStorage` getter scoped to the plugin name:

```js
class MyPlugin extends Plugin {
  async install(initialState) {
    await super.install(initialState);

    // Read with a default
    const enabled = this.uiStorage.get('featureEnabled', false);

    // Write
    this.uiStorage.set('featureEnabled', true);

    // Remove
    this.uiStorage.remove('featureEnabled');
  }
}
```

The storage namespace is the plugin's `name` property (e.g. `xmleditor`). Keys are stored as `ui.<namespace>.<key>` in localStorage — e.g. `ui.xmleditor.lineWrapping`.

---

## API reference

### `UIStorage` — `app/src/modules/ui-storage.js`

```js
new UIStorage(namespace, storage = localStorage)
```

| Method | Signature | Description |
| --- | --- | --- |
| `get` | `get(key, defaultValue?)` | Returns JSON-parsed value, or `defaultValue` if absent |
| `set` | `set(key, value)` | JSON-serializes and writes |
| `remove` | `remove(key)` | Removes a single key |
| `bind` | `bind(element, property, options)` | DOM binding — see below |

### `bind(element, property, options)`

Restores a stored value to a DOM element on call and saves it back whenever a DOM event fires.

```js
const unbind = this.uiStorage.bind(element, property, {
  key: 'storageKey',       // required — key within this namespace
  event: 'sl-change',      // required — DOM event to listen for
  default: initialValue,   // optional — used when nothing is stored yet
});

// Later, to stop listening:
unbind();
```

**Contract:**

1. On call: reads `key` and assigns `element[property]` (uses `default` if nothing stored yet).
2. Attaches `event` listener: on every event, writes `element[property]` to storage.
3. Returns an unbind function that removes the listener.

**Guards:** throws if `element` is null/undefined, `key` is missing, or `event` is missing.

### Shoelace event reference

| Component | Property | Event to use |
| --- | --- | --- |
| `sl-split-panel` | `position` | `sl-reposition` |
| `sl-switch`, `sl-checkbox` | `checked` | `sl-change` |
| `sl-select`, `sl-input` | `value` | `sl-change` |

---

## Worked example — split panel position

```js
// app/src/plugins/layout.js
async install(initialState) {
  await super.install(initialState);
  this.uiStorage.bind(ui.editors, 'position', {
    key: 'splitPosition',
    event: 'sl-reposition',
    default: 50,
  });
}
```

On load: reads `ui.layout.splitPosition` from localStorage and sets `ui.editors.position`. On every drag: writes the new position back. After page reload, the panel reopens at the saved position.

---

## Key naming convention

Keys are stored as `ui.<namespace>.<key>`:

- `ui.layout.splitPosition`
- `ui.xmleditor.lineWrapping`
- `ui.xmleditor.xpath.variant1`
- `ui.teitools.teiHeaderVisible`

The namespace comes from `this.name` on the plugin. Sub-keys (like `xpath.${variantId}`) use dot notation within the key string — UIStorage treats the whole thing as an opaque string.

---

## Testing

Inject a custom storage backend instead of `localStorage`:

```js
import { UIStorage } from '../../../app/src/modules/ui-storage.js';

const mockStorage = new Map();
const backend = {
  getItem: (k) => mockStorage.get(k) ?? null,
  setItem: (k, v) => mockStorage.set(k, v),
  removeItem: (k) => mockStorage.delete(k),
};
const storage = new UIStorage('test', backend);
```

See `tests/unit/js/ui-storage.test.js` for the full test suite (15 tests).

---

## Swapping the backend

The `PluginContext.getUIStorage(namespace)` factory is the single point where the storage implementation is chosen. To swap all plugins to a server-backed store, change only that method:

```js
// app/src/modules/plugin-context.js
getUIStorage(namespace) {
  return new UIStorage(namespace, myServerBackedStorage);
}
```

No changes needed in individual plugins.

---

## Global layout state

`LayoutPlugin` (`app/src/plugins/layout.js`) owns UI elements in `index.html` that are not owned by any other plugin. It is the home for future global layout preferences (panel visibility, sidebar width, etc.). Add new global bindings there rather than creating ad-hoc localStorage writes.
