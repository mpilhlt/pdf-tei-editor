# Frontend Plugin Architecture Simplification

## Context

The frontend plugin system has accumulated complexity from two coexisting patterns (object-based and class-based), a double-system of plugin object + separate api export, and monolithic `onStateUpdate` / `state.update` handlers. Issues #290, #191, #229, #141, #189, #128 all address symptoms of this. The goal is to unify these into a coherent, simple system that better exploits the existing extension point infrastructure, without breaking existing plugins.

---

## Architecture: Two Patterns, One System

The plugin system supports two patterns that are complementary, not competing:

**Object-based (primitive):** The foundation, based on the js-plugin architecture. A plain object with a `name`, optional `deps`, and methods at paths matching extension point names. Fully supported, no plans to remove. Best for simple plugins or when class overhead is unnecessary.

**Class-based (convenience layer):** Built on top of the object-based pattern. `Plugin` instances are converted to plugin objects via `getExtensionPoints()` before registration. Adds:

- `this.state` (automatic state tracking)
- `this.dispatchStateChange()`, `this.hasStateChanged()`
- `this.getDependency(name)` (runtime DI)
- `on<Key>Change` auto-wiring and `static extensionPoints` auto-discovery
- Singleton pattern (`Plugin.getInstance()`)
- The class instance IS the public API — no separate `api` export needed

**Recommendation:** Use class-based for new plugins and when migrating complex plugins. Object-based remains valid for simple, self-contained plugins.

**BC requirement:** Object-based plugins continue to work unchanged. Migration is per-plugin, opt-in.

---

## Implementation Steps

### Step 1 — `getDependency(name)` (Issue #290)

**Status:** DONE

Add to:

- `app/src/modules/plugin-manager.js`: `#pluginApis = new Map()`, populated in `register()` from `plugin.api ?? instance`. Add `getDependency(name)`.
- `app/src/modules/application.js`: `getDependency(name)` delegating to PluginManager.
- `app/src/modules/plugin-context.js`: `getDependency(name)` delegating to Application.
- `app/src/modules/plugin-base.js`: `getDependency(name)` convenience method delegating to `this.context.getDependency(name)`.

For object plugins, add `api` field to the plugin descriptor so the manager stores the correct public API:

```js
export const plugin = { name: 'xmleditor', api, deps: [...] }
export const api = xmlEditor
```

Affected object plugins: `config.js`, `sse.js`, `progress.js`, `dialog.js`, `pdfviewer.js`, `xmleditor.js`, `tei-validation.js`, `client.js`, `file-selection.js`, `file-selection-drawer.js`, `extraction.js`, `document-actions.js`, `services.js`, `prompt-editor.js`, `info.js`, `annotation-guide.js`, `sync.js`, `access-control.js`, `heartbeat.js`, `url-hash-state.js`.

BC: retain all existing named exports from `app.js` as aliases.

---

### Step 2 — Terminology: "extension points" not "endpoints" (Issue #141)

**Status:** DONE

- Rename `app/src/endpoints.js` → `app/src/extension-points.js`
- Update all variable names, JSDoc strings: `endpoint` → `extensionPoint`
- Update `getEndpoints()` → `getExtensionPoints()` in `plugin-base.js` (keep `getEndpoints()` as deprecated alias)
- Update all documentation and references

Pure naming change, no behavior changes.

---

### Step 3 — Auto-discovery in `Plugin` base class

**Status:** DONE

Changes to `app/src/modules/plugin-base.js`:

a. **`static extensionPoints`**: If a subclass declares `static extensionPoints = ['ns.method', ...]`, `getExtensionPoints()` maps each to `this[lastSegment].bind(this)` (e.g. `ns.method` → `this.method`).

b. **`on<Key>Change` auto-discovery**: `getExtensionPoints()` scans the instance's prototype chain for methods matching `/^on([A-Z][a-zA-Z]*)Change$/`, and registers each as `onStateUpdate.<lowerKey>` (e.g. `onXmlChange` → `onStateUpdate.xml`).

c. Rename `getEndpoints()` → `getExtensionPoints()`, keep `getEndpoints()` as deprecated alias calling `getExtensionPoints()`.

The auto-discovered entries are merged with any explicit entries returned by a `getExtensionPoints()` override, giving explicit entries priority.

---

### Step 4 — Per-key state dispatch in `Application.updateState()`

**Status:** DONE

Changes to `app/src/modules/application.js`:

After creating `newState` and `changedKeys`, dispatch per changed key:

```js
for (const key of changedKeys) {
  const newVal = newState[key]
  const prevVal = this.#stateManager.getPreviousStateValue(newState, key)
  // Object plugins: state.<key>(newVal, prevVal, newState)
  await this.#pluginManager.invoke(`state.${key}`, [newVal, prevVal, newState], { mode: 'sequential' })
  // Class plugins: onStateUpdate.<key>(newVal, prevVal)  — auto-discovered on<Key>Change methods
  await this.#pluginManager.invoke(`onStateUpdate.${key}`, [newVal, prevVal], { mode: 'sequential' })
}
```

This dispatch runs after `updateInternalState` and before (or after) `onStateUpdate` catch-all — order TBD during implementation (before is preferable so per-key handlers fire first).

Existing `state.update` and `onStateUpdate(changedKeys)` continue to work.

---

### Step 5 — Build step: auto-generate `plugins.js` and `plugin-registry.js` (Issue #191)

**Status:** DONE (plugin-registry.js only; plugins.js ordering is manually maintained)

Add a `plugins` step to `bin/build.js` (alongside `importmap`, `templates`, `bundle`):

1. Scan `app/src/plugins/*.js`
2. Detect:
   - `export default class XxxPlugin extends Plugin` → class-based
   - `export const plugin = { name: '...', ... }` → object-based
3. Generate `app/src/plugins.js` with all imports, plugins array, BC API re-exports
4. Generate `app/src/modules/plugin-registry.js`:

```js
// AUTO-GENERATED by bin/build.js --steps=plugins — do not edit manually
/**
 * Maps plugin names to their public API types for getDependency() typing.
 * @typedef {object} PluginRegistryTypes
 * @property {import('../plugins/client.js').default} client
 * @property {import('../plugins/xmleditor.js').default} xmleditor
 * ...
 */
```

`getDependency` in `plugin-base.js` is typed:

```js
/**
 * @template {keyof PluginRegistryTypes} N
 * @param {N} name
 * @returns {PluginRegistryTypes[N]}
 */
getDependency(name) { return this.context.getDependency(name) }
```

Run via: `node bin/build.js --steps=plugins`

---

### Step 6 — Migrate plugins

**Status:** TODO

Migrate object-based plugins one at a time to class-based, following `docs/code-assistant/plugin-migration-guide.md`.

Priority order (start with simpler plugins):

1. `url-hash-state.js` (small, no UI)
2. `heartbeat.js` (small, no UI)
3. `progress.js`
4. `sse.js`
5. `config.js`
6. `client.js`
7. `dialog.js`
8. `tei-validation.js`
9. `file-selection.js`
10. `file-selection-drawer.js`
11. `pdfviewer.js`
12. `xmleditor.js` (largest, most complex — do last)

For each: read, migrate, verify in browser, run E2E tests.

---

## Critical Files

| File | Change |
|------|--------|
| `app/src/modules/plugin-base.js` | `on<Key>Change` auto-discovery, `static extensionPoints`, rename `getEndpoints()` |
| `app/src/modules/plugin-manager.js` | `#pluginApis` Map, `getDependency(name)`, store api on registration |
| `app/src/modules/plugin-context.js` | `getDependency(name)` |
| `app/src/modules/application.js` | Per-key dispatch in `updateState()`, `getDependency(name)` |
| `app/src/endpoints.js` | Rename → `extension-points.js`, update all terms |
| `app/src/plugins.js` | Updated as plugins are migrated; eventually auto-generated |
| `bin/build.js` | Add `plugins` step |
| `app/src/modules/plugin-registry.js` | New (auto-generated): `PluginRegistryTypes` typedef |
| `docs/development/plugin-system-frontend.md` | Update with new patterns |
| `docs/code-assistant/plugin-development.md` | Update with new patterns |
| `docs/code-assistant/plugin-migration-guide.md` | Agent instruction file (already written) |

---

## Verification

1. Dev server loads without console errors after each incremental change.
2. Auth, file loading, XML editor, PDF viewer all functional after `plugin-base.js` changes.
3. `npm run test:e2e` full suite passes.
4. For each migrated plugin: exercise its UI and run E2E tests.
5. `node bin/build.js --steps=plugins` regenerates `plugins.js` and matches hand-maintained version.

---

## Implementation Progress

Steps 1–5 complete. Changes made:

**Step 1 — `getDependency(name)`:**

- `plugin-manager.js`: Added `pluginApis` Map; populates on `register()` (Plugin instance → instance, `plugin.api` → api, otherwise plugin object); removes on `unregister()`; added `getDependency(name)` method.
- `application.js`: Added `getDependency(name)` delegating to `#pluginManager`.
- `plugin-context.js`: Added `getDependency(name)` delegating to `#application`.
- `plugin-base.js`: Added `getDependency(name)` convenience method (typed via PluginRegistryTypes template).
- `plugin-registry.js` (new): JSDoc `@typedef PluginRegistryTypes` mapping plugin names to types.

**Step 2 — Terminology:**

- `extension-points.js` (new): The canonical extension points file with updated terminology.
- `endpoints.js`: Replaced with a re-export shim from `extension-points.js` for backward compat.
- `application.js`, `app.js`: Updated to import from `extension-points.js`.
- Removed TODO comment from `plugin-manager.js`.

**Step 3 — Auto-discovery in Plugin base:**

- `plugin-base.js`: `getExtensionPoints()` replaces `getEndpoints()` (kept as deprecated alias).
  - Auto-discovers lifecycle methods, `static extensionPoints` declarations, and `on<Key>Change` methods.
  - `#prototypeChain()` private generator walks the prototype chain for method discovery.
- `plugin-manager.js`: `convertPluginInstance()` calls `getExtensionPoints()` (with fallback to `getEndpoints()`).

**Step 4 — Per-key state dispatch:**

- `application.js`: After `onStateUpdate` catch-all, iterates `changedKeys` and dispatches `state.<key>([newVal, prevVal, state])` and `onStateUpdate.<key>([newVal, prevVal])` for each changed key.

**Step 5 — Build step:**

- `bin/generate-plugins.js` (new): Scans plugin files, generates `plugin-registry.js`, validates `plugins.js` completeness.
- `bin/build.js`: Added `plugins` step running `generate-plugins.js`, inserted first in step order.

**Step 6 — Plugin migration:** TODO (use `docs/code-assistant/plugin-migration-guide.md`)

**Step 7 — Documentation update:** TODO

Update `docs/development/plugin-system-frontend.md` and `docs/code-assistant/plugin-development.md`:

- Remove "legacy" / "modern" framing. The object-based pattern is the primitive that the class-based system is built on top of — it remains fully supported and is a valid choice.
- Primary docs describe the class-based API (as it is what most plugin authors will use), with all examples in class-based style.
- Add a separate document `docs/development/plugin-system-object-based.md` that explains the underlying object-based (js-plugin-compatible) pattern: the plugin descriptor shape, how extension point paths map to nested object properties, the state update handler signature, and how `api` field integrates with `getDependency`. Link to it from the main frontend plugin system doc with a note such as: "The class-based `Plugin` class is implemented on top of this primitive pattern. If you need to understand the lower-level mechanics or work with object-based plugins directly, see [Object-Based Plugin Pattern](plugin-system-object-based.md)."
- In `plugin-manager.js` header JSDoc: update description to reflect that both patterns are first-class, not that one is a "superset" of the other in a "legacy compatibility" sense.
