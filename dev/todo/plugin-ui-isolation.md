# Plugin UI Isolation and Passive Registration

**GitHub Issues:** #332, #189, #229

---

## Architecture (Stage 1) — COMPLETE

### A. Inter-plugin communication rules

| Method | Use when |
|--------|----------|
| `dispatchStateChange` | Broadcasting domain state to unknown or multiple consumers |
| Extension points (`static extensionPoints`) | A host plugin needs structured contributions from many plugins; additive, defined at install/start time |
| `getDependency()` API | Interaction is directed at one specific plugin, or a synchronous return value is required |

Cross-plugin UI access via the global `ui` is never correct.

### B. Scoped local UI

`Plugin.createUi(element)` wraps `createNavigableElement()` and returns a navigable subtree local to the plugin. Plugins store the result as `this.#ui` instead of reading from the global `ui` object.

### C. Passive toolbar/menu registration

Plugins declare `static extensionPoints = [ep.toolbar.contentItems]` and implement `contentItems()` returning `[{ element, priority, position }]`. `ToolbarPlugin.start()` collects all contributions and adds them. For items that must be in the DOM during `install()` (for backward compat with other plugins), the element is still added in `install()` and `contentItems()` is a no-op; `toolbar.start()` skips already-connected elements.

`ToolbarPlugin` also exposes public `add(element, priority, position)` and `remove(widgetId)` for dynamic items.

### D. Auto-generated typedefs from templates

`bin/generate-ui-types.js` scans `app/src/templates/*.html`, mirrors `findNamedDescendants()` hierarchy, and generates sibling `*.types.js` files. Run with `npm run build:ui-types`. Stale output files are deleted automatically. `sl-icon` and `sl-icon-button` are excluded from `name`-attribute navigation detection in both the generator and `ui-system.js`.

---

## Completed changes

- **`bin/generate-ui-types.js`** — new build script; 36 type files generated from templates; deletes stale files; excludes `sl-icon`/`sl-icon-button` from navigation detection
- **`package.json`** — added `"build:ui-types"` script
- **`app/src/modules/plugin-base.js`** — added `createUi(element)` method; `getExtensionPoints()` discovers computed methods via full EP path key; removed deprecated last-segment fallback and `getEndpoints()` shim
- **`app/src/modules/plugin-manager.js`** — removed `getEndpoints` fallback in `convertPluginInstance()`
- **`app/src/extension-points.js`** — added `toolbar.contentItems`, `toolbar.menuItems`, `backendPlugins.execute`
- **`app/src/modules/panels/base-panel.js`** — added `'left'|'center'|'right'` string support to `_addWidget()` `where` parameter
- **`app/src/plugins/toolbar.js`** — `start()` collects `toolbar.contentItems`/`toolbar.menuItems` from all plugins (skips already-connected elements); added public `add()` and `remove()` methods
- **`app/src/modules/ui-system.js`** — `findNamedDescendants()` ignores `name` attribute on `sl-icon` and `sl-icon-button` (inline check to avoid circular-import TDZ)
- **`app/src/plugins/document-actions.js`** — pilot migration (see below)
- **`app/src/plugins/tei-validation.js`**, **`xmleditor.js`**, **`filedata.js`**, **`file-selection.js`**, **`backend-plugins.js`** — migrated to computed method EP pattern; `static extensionPoints` now uses `ep` constants
- **`docs/code-assistant/plugin-communication.md`** — new document on inter-plugin communication (state, extension points, `getDependency`)

---

## Pilot: document-actions.js — COMPLETE, all tests pass

Changes made:

- `static extensionPoints = [ep.toolbar.contentItems]` with computed method `[ep.toolbar.contentItems]()` returning `[{ element: this.#ui, priority: 8, position: 'center' }]`
- Private `#ui` (scoped navigable span) and `#dialogUi` (scoped navigable dialog)
- `install()` calls `this.createUi(span)` and `this.createUi(dialog)`; still calls `ui.toolbar.add(span, 8)` + `updateUi()` for backward compat with `move-files` plugin which appends a button to `ui.toolbar.documentActions` in its own `install()`
- `toolbar.start()` skips already-connected elements
- All own-element accesses use `this.#ui.documentActions.*` instead of `ui.toolbar.documentActions.*`
- `saveRevision()` uses `this.#dialogUi` instead of `ui.saveDocumentDialog`

Backward compat constraint: `move-files.js` calls `ui.toolbar.documentActions.append(this.#moveBtn)` in its `install()`. Until `move-files` is migrated, `document-actions.install()` must keep adding the element to the toolbar and calling `updateUi()`.

---

## Migration Guide (Stage 2) — PENDING

### Backward compatibility

The global `ui` object and `updateUi()` remain functional throughout migration. Plugins migrate one at a time.

### Migration checklist per plugin

**Step 0 — Replace legacy inter-plugin imports with `getDependency` getters**

While touching any plugin file, also clean up legacy dependency access patterns:

- Replace module-level `import { api as foo } from './other-plugin.js'` with a private getter:

  ```js
  get #foo() { return this.getDependency('other-plugin') }
  ```

- Replace constructor assignment of a private dependency field (`this.#foo = this.getDependency('foo')` or similar) with the same getter pattern — it is lazy and avoids initialization-order issues.
- Only keep a plugin in `deps` if it must be installed before this plugin's own `install()` runs. Dependencies only needed at action time (button clicks, async operations) do not belong in `deps`.

**Step 1 — Identify cross-plugin `ui` accesses**

- Grep: `ui\.[a-zA-Z]+\.[a-zA-Z]+` in plugin files
- For each access to another plugin's subtree, choose replacement: state key or `getDependency()` API

**Step 2 — Replace cross-plugin widget mutations with state or API**

- Priority: `access-control.js` — `ui.xmlEditor.headerbar.readOnlyStatus` → add `ext.readOnlyContextText` to state, or `getDependency('xmleditor').setReadOnlyContext({text, icon})`

**Step 3 — Convert static toolbar/menu additions to extension points**
For each plugin calling `ui.toolbar.add(element)` in `install()`:

1. Add `static extensionPoints = [ep.toolbar.contentItems]`
2. Implement a computed method returning the contribution function:

```javascript
  /**
-  * Contribute toolbar buttons to the main toolbar.
-  * Called by ToolbarPlugin.start() via the toolbar.contentItems extension point.
-  * @returns {Array<{element: HTMLElement, priority: number, position: string}>}
   */
  [ep.toolbar.contentItems]() {
    return [{ element: this.#ui, priority: 8, position: 'center' }]
  }
```

3. Once all plugins that depend on `ui.toolbar.<widgetName>` during install are also migrated, remove the direct `ui.toolbar.add()` + `updateUi()` from `install()`

**Step 4 — Convert to scoped `this.#ui`**

1. After creating element from template: `this.#ui = this.createUi(rootElement)`
2. Replace `ui.pluginName.subElement` with `this.#ui.subElement`
3. Remove `import ui from '../ui.js'` if no longer needed
4. Remove `updateUi()` calls that were only needed for own-plugin element access

**Step 5 — Replace hand-written typedefs with generated files**

1. Run `npm run build:ui-types`
2. Remove `@typedef` blocks in plugin files covered by generated `*.types.js`
3. Replace `@import { xPart } from './x.js'` with `@import { xPart } from '../templates/x.types.js'`
4. Update `app/src/ui.js` top-level typedef to import from generated files

**Step 6 — Update docs and tests** (after each migration batch)

- `docs/code-assistant/plugin-development.md`: replace global `ui` examples with `this.createUi()` pattern; add passive toolbar registration section
- `docs/code-assistant/plugin-migration-guide.md`: add steps for new patterns
- `docs/code-assistant/architecture-frontend.md`: update inter-plugin communication section with rule table from §A
- Add/update E2E test assertions for toolbar item placement

### Migration order

1. ~~Pilot: `document-actions.js`~~ ✓
2. `toolbar.js` — already has extension point collection; remove legacy typedef imports from child plugins once those are migrated
3. `move-files.js` — uses `ui.toolbar.documentActions.append()`; migrate to `getDependency('document-actions').addButton()` or a `toolbar.contentItems` contribution that appends to the button group via a returned element
4. All remaining plugins adding static toolbar/menu items: `file-selection.js`, `extraction.js`, `tools.js`, `user-account.js`, `file-selection-drawer.js`, etc.
5. `access-control.js` — cross-plugin widget mutation (#332)
6. Remaining plugins with `ui.otherPlugin.*` accesses
7. Remaining plugins with own-plugin `ui` access only

### Verification

- `npm run build:ui-types` — no errors
- Run E2E tests — all pass
- Grep `ui\.[a-zA-Z]+\.[a-zA-Z]+\.[a-zA-Z]+` in plugin files — no cross-plugin `ui` accesses remain
- Toolbar renders correctly with all plugins' widgets in correct order/position
- IDE autocomplete works on `this.#ui.*` in migrated plugins
