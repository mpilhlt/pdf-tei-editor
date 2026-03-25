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

**Status:** partially DONE

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

none of the plugin objects have been migrated yet.

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

### Step 5 — Build step: auto-generate `plugin-registry.js` (Issue #191)

**Status:** DONE (`plugins.js` ordering is manually maintained; `plugin-registry.js` is fully auto-generated)

`bin/build.js --steps=plugins` runs `bin/generate-plugins.js`, which:

1. Scans `app/src/plugins/*.js` and detects class-based vs object-based plugins
2. Generates `app/src/plugin-registry.js` with:
   - Re-export statements for all class-based plugins (so `plugins.js` imports from one place)
   - An inline `@typedef` mapping every plugin name to its public API type (supports dashed names via quoted keys)

`plugins.js` imports all class-based plugins from `plugin-registry.js`. Object-based plugin imports remain direct. When a plugin is migrated to class-based (Step 6), remove its direct import from `plugins.js` and re-run `node bin/build.js --steps=plugins` to add it to the registry.

Run via: `node bin/build.js --steps=plugins`

---

### Step 6 — Migrate plugins

**Status:** DONE

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
| ------ | -------- |
| `app/src/modules/plugin-base.js` | `on<Key>Change` auto-discovery, `static extensionPoints`, rename `getEndpoints()` |
| `app/src/modules/plugin-manager.js` | `#pluginApis` Map, `getDependency(name)`, store api on registration |
| `app/src/modules/plugin-context.js` | `getDependency(name)` |
| `app/src/modules/application.js` | Per-key dispatch in `updateState()`, `getDependency(name)` |
| `app/src/endpoints.js` | Rename → `extension-points.js`, update all terms |
| `app/src/plugins.js` | Class-based imports from `./plugin-registry.js`; plugins array and BC exports manually maintained |
| `bin/build.js` | Add `plugins` step |
| `app/src/plugin-registry.js` | Auto-generated: class-based re-exports + `PluginRegistryTypes` typedef |
| `docs/development/plugin-system-frontend.md` | Update with new patterns |
| `docs/code-assistant/plugin-development.md` | Update with new patterns |
| `docs/code-assistant/plugin-migration-guide.md` | Agent instruction file (already written) |

---

## Verification

1. Dev server loads without console errors after each incremental change.
2. Auth, file loading, XML editor, PDF viewer all functional after `plugin-base.js` changes.
3. `npm run test:e2e` full suite passes.
4. For each migrated plugin: exercise its UI and run E2E tests.
5. `node bin/build.js --steps=plugins` regenerates `plugin-registry.js` without errors.

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

- `bin/generate-plugins.js` (new): Scans plugin files, generates `app/src/plugin-registry.js` (re-exports + typedef), validates `plugins.js` completeness.
- `bin/build.js`: Added `plugins` step running `generate-plugins.js`, inserted first in step order.
- `app/src/plugin-registry.js` (new, at `app/src/` level): Re-exports all class-based plugins by class name; inline `@typedef PluginRegistryTypes` with quoted keys for dashed plugin names.
- `app/src/plugins.js`: Class-based plugin imports consolidated to a single import from `./plugin-registry.js`.
- `app/src/modules/plugin-base.js`: Updated JSDoc import path to `../plugin-registry.js`.

**Step 6 — Plugin migration:** DONE

**`services.js`:** Converted to `ServicesPlugin extends Plugin`. All plugin APIs acquired via `getDependency()` in `install()`. `currentState` module variable eliminated (replaced by `this.state`). `onStateUpdate` removed. `pluginManager.invoke(...)` replaced with `this.context.invokePluginEndpoint(...)`. `app.updateState(...)` replaced with `this.dispatchStateChange(...)`. Self-referencing dynamic import in `uploadXml` replaced with `this.load(...)`. Lazy proxy BC export retained for `app.js` re-export chain. `getNodeText`/`getTextNodes` kept as module-level private utilities.

**`start.js`:** Converted to `StartPlugin extends Plugin`. `state.update` handler removed (auto-tracked by base class). `app.invokePluginEndpoint(...)` replaced with `this.context.invokePluginEndpoint(...)`. `app.updateState(...)` replaced with `this.dispatchStateChange(...)`. `configureFindNodeInPdf` made private (`#configureFindNodeInPdf`). `HeartbeatPlugin.getInstance()` still called directly (singleton is safe post-install).

**`plugins.js`:** `fileselectionPlugin` and `servicesPlugin`/`startPlugin` object imports removed. All plugin classes now imported exclusively from `plugin-registry.js`. BC proxy `api` imports kept only for the named re-exports used by `app.js`.

The target state for `plugins.js` is: it exports only the `plugins` array (default export). All other named exports are loose-coupling violations — they exist because consuming plugins import peer APIs via `app.js`/`plugins.js` instead of using `getDependency()`. BC proxy exports in plugin files are temporary shims; their use should be marked `@deprecated` in JSDoc and eliminated as consuming plugins are updated.

### Fully migrated — no remaining exports or loose coupling

| Plugin file | Class |
| --- | --- |
| `authentication.js` | `AuthenticationPlugin` |
| `backend-plugins.js` | `BackendPluginsPlugin` |
| `config-editor.js` | `ConfigEditorPlugin` |
| `filedata.js` | `FiledataPlugin` |
| `file-selection-drawer.js` | `FileSelectionDrawerPlugin` |
| `heartbeat.js` | `HeartbeatPlugin` |
| `help.js` | `HelpPlugin` |
| `info.js` | `InfoPlugin` |
| `logger.js` | `LoggerPlugin` |
| `move-files.js` | `MoveFilesPlugin` |
| `progress.js` | `ProgressPlugin` |
| `prompt-editor.js` | `PromptEditorPlugin` |
| `rbac-manager.js` | `RbacManagerPlugin` |
| `sse.js` | `SsePlugin` |
| `tei-tools.js` | `TeiToolsPlugin` |
| `tei-wizard.js` | `TeiWizardPlugin` |
| `toolbar.js` | `ToolbarPlugin` |
| `tools.js` | `ToolsPlugin` |
| `url-hash-state.js` | `UrlHashStatePlugin` |
| `user-account.js` | `UserAccountPlugin` |
| `xsl-viewer.js` | `XslViewerPlugin` |
| `services.js` | `ServicesPlugin` |
| `start.js` | `StartPlugin` |

### Class-based but still causing exports or loose coupling in `plugins.js`

The plugin class exists, but consuming plugins still import the BC proxy via `app.js` (which re-exports everything from `plugins.js`) instead of using `getDependency()`. Removing the export requires updating all consumers to call `getDependency()`. BC proxy exports in the plugin files must be marked `@deprecated`.

| Plugin file | Class | BC export still in `plugins.js` | Consumed by / notes |
| --- | --- | --- | --- |
| `access-control.js` | `AccessControlPlugin` | `accessControl` | `services.js` via `app.js`; can be removed once `services.js` migrated |
| `annotation-guide.js` | `AnnotationGuidePlugin` | — | imports `api as extraction` and `api as clientApi` directly from plugin files (not via `app.js`) |
| `client.js` | `ClientPlugin` | `client` | `app.js` bootstrap, many migrated plugins import `api as clientApi` directly |
| `config.js` | `ConfigPlugin` | `config` | `app.js` bootstrap; migrated plugins now import `api as configApi` directly from `config.js` |
| `dialog.js` | `DialogPlugin` | `dialog` | migrated plugins use `getDependency('dialog')` directly; BC export remains for `app.js` re-export |
| `document-actions.js` | `DocumentActionsPlugin` | — | no BC export |
| `extraction.js` | `ExtractionPlugin` | `extraction` | `annotation-guide.js` uses `extraction.extractorInfo()`; can use `getDependency('extraction').extractorInfo()` once annotation-guide no longer imports directly |
| `file-selection.js` | `FileSelectionPlugin` | `fileselection` | still registered via `plugin as fileselectionPlugin` in plugins.js — switch to `FileSelectionPlugin` from registry |
| `pdfviewer.js` | `PdfViewerPlugin` | `pdfViewer` | `services.js` via `app.js` |
| `tei-validation.js` | `TeiValidationPlugin` | `validation` | `services.js` via `app.js` |
| `xmleditor.js` | `XmlEditorPlugin` | `xmlEditor` | migrated plugins import `api as xmlEditorApi` directly from `xmleditor.js` |

`SsePlugin` and `XslViewerPlugin` are exported because `frontend-extension-sandbox.js` and `backend-plugin-sandbox.js` import them directly from `plugins.js` — a separate loose-coupling violation in the sandbox modules.

`logLevel` (an enum constant from `logger.js`) is exported for `app.js` bootstrap; it can be imported directly from `./plugins/logger.js` in `app.js` once the re-export is cleaned up.

The `app.js` bootstrap uses `client`, `config`, and `services` before plugins are installed, so `getDependency()` is unavailable at that point. These must be imported directly from their plugin files in `app.js`.

### Not yet migrated — still object-based

All plugins have been migrated.

### Cleanup remaining in `plugins.js` (after migrations above)

All class imports now come from `plugin-registry.js`. Remaining BC proxy exports (`config`, `dialog`, `pdfViewer`, `xmlEditor`, `validation`, `client`, `fileselection`, `extraction`, `services`, `accessControl`) are retained for `app.js` re-exports and any code that hasn't yet switched to `getDependency()`.

---

### Lessons learned (for future sessions)

**Pattern for accessing APIs of not-yet-migrated plugins:** Import `api as xyzApi` directly from the plugin file (e.g., `import { api as clientApi } from './client.js'`). Do NOT import via `app.js` or `plugins.js`. This avoids circular dependencies and works regardless of whether the target plugin has been migrated.

**`getDependency()` vs direct import:** Use `getDependency(name)` only for plugins fully declared in `deps`. Use direct `api` imports for plugins that are not in `deps` (to avoid circular dependency chains). Always check the dep chain before adding to `deps`.

**`dialog.js` refactor:** Dialog methods (`info`, `error`, `success`, `confirm`, `prompt`) were moved into the `DialogPlugin` class and the `api` export changed to a lazy proxy. All migrated plugins now call `this.getDependency('dialog').error(...)` directly — no separate `dialogApi` import needed.

**`onUserChange` timing:** When a plugin tracks user state to show/hide UI, `onUserChange` fires during initial state setup before `start()` creates UI elements. Fix: read `this.state.user` directly inside `start()` to set initial visibility, rather than relying on `onUserChange` for first render.

**Dead variables:** The original `teiHeaderVisible` in `tei-tools.js` was set but never read (state is persisted only in localStorage). Removed the field rather than converting it to `#teiHeaderVisible`.

**Nested functions in class methods:** Functions like `createOptionElement` and `updateDynamicOptions` inside `extractFromPDF`/`promptForExtractionOptions` close over method-local variables. These remain as nested functions inside the class method — no need to convert them to class methods since they don't need `this` access beyond what is captured via `const state = this.state` at method entry.

**`app.js` re-export trap:** Several plugins previously imported `xmlEditor`, `logger`, `dialog`, etc. from `app.js`. After migration these must import directly from the plugin file or use `getDependency()`. Never re-introduce imports from `app.js` in migrated plugins.

**Step 7 — Documentation update:** TODO

Update `docs/development/plugin-system-frontend.md` and `docs/code-assistant/plugin-development.md`:

- Remove "legacy" / "modern" framing. The object-based pattern is the primitive that the class-based system is built on top of — it remains fully supported and is a valid choice.
- Primary docs describe the class-based API (as it is what most plugin authors will use), with all examples in class-based style.
- Add a separate document `docs/development/plugin-system-object-based.md` that explains the underlying object-based (js-plugin-compatible) pattern: the plugin descriptor shape, how extension point paths map to nested object properties, the state update handler signature, and how `api` field integrates with `getDependency`. Link to it from the main frontend plugin system doc with a note such as: "The class-based `Plugin` class is implemented on top of this primitive pattern. If you need to understand the lower-level mechanics or work with object-based plugins directly, see [Object-Based Plugin Pattern](plugin-system-object-based.md)."
- In `plugin-manager.js` header JSDoc: update description to reflect that both patterns are first-class, not that one is a "superset" of the other in a "legacy compatibility" sense.
