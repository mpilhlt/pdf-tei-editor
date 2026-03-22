# Agent Instruction: Migrate a Frontend Plugin to the New Architecture

This guide instructs an agent to migrate ONE frontend plugin file from the old patterns to the new architecture. Read it fully before starting. Do not migrate multiple plugins in a single session.

**Prerequisite**: The framework changes described in `dev/todo/plugin-architecture-simplification.md` sections 1–5 must already be applied to `Plugin` base class, `Application`, and `PluginManager` before migrating any plugin.

---

## Step 1: Identify the plugin type

Read the plugin file completely before touching anything.

- **Object-based**: exports `export const plugin = { name, deps?, install?, state: { update? }, ... }` and optionally `export const api = { ... }`
- **Class-based (old style)**: exports `export default class XxxPlugin extends Plugin`, may use `getEndpoints()` for custom extension points and/or `onStateUpdate(changedKeys)` for state handling

If already class-based and using the new patterns, there may be nothing to do — verify first.

---

## Step 2: Convert object-based to class-based

If already class-based, skip to Step 3.

### 2.1 Create the class skeleton

```js
/**
 * @import { PluginContext } from '../modules/plugin-context.js'
 * @import { ApplicationState } from '../state.js'
 * ... (keep existing @import blocks)
 */

import { Plugin } from '../modules/plugin-base.js'

class XxxPlugin extends Plugin {
  /**
   * @param {PluginContext} context
   */
  constructor(context) {
    super(context, { name: '<name from plugin object>', deps: [/* deps from plugin object */] })
  }
}

export default XxxPlugin
```

### 2.2 Move lifecycle functions into class methods

- `install(state)` → `async install(state) { await super.install(state); ... }`
- `start()` → `async start() { ... }`
- `shutdown()` → `async shutdown() { ... }`

### 2.3 Replace module-level state variables

- Remove `let currentState` (and any other module-level state copies)
- Replace all uses of `currentState` with `this.state`
- All other module-level variables that were effectively "instance state" become private class fields: `#myVar` declared in the class body and assigned in `install()` or the constructor

### 2.4 Move the state update handler into the class

Move the existing `update(state)` or `onStateUpdate(changedKeys, state)` function into the class:

```js
async onStateUpdate(changedKeys) {
  // this.state is the new state, no parameter needed
  ...
}
```

### 2.5 Split `onStateUpdate` into per-key handlers

For each `if (hasStateChanged(state, 'key'))` or `if (changedKeys.includes('key'))` block, extract into a dedicated `on<Key>Change` method. The method name is `on` + capitalised state key + `Change`:

```js
// Before: if (changedKeys.includes('xml')) { ... }
// After:
async onXmlChange(newValue, prevValue) {
  // newValue === this.state.xml
  // prevValue is the previous value of state.xml
  ...
}
```

Rules for splitting:

- Extract each single-key guard into its own method
- Keep `onStateUpdate(changedKeys)` only for logic that genuinely depends on multiple keys changing together
- If the old handler only stored `currentState = state` and then did per-key checks, it can be replaced entirely by per-key methods (drop the catch-all)

### 2.6 Move module-level instance variables into the class

```js
// Before (module level):
let myEditor = new NavXmlEditor('container')

// After (class body + install):
class XxxPlugin extends Plugin {
  /** @type {NavXmlEditor} */
  #editor

  async install(state) {
    await super.install(state)
    this.#editor = new NavXmlEditor('container')
  }
}
```

### 2.7 Move custom extension point functions into class methods

Replace `getEndpoints()` overrides with `static extensionPoints`:

```js
// Before:
getEndpoints() {
  return {
    ...super.getEndpoints(),
    'validation.inProgress': this.inProgress.bind(this)
  }
}

// After:
static extensionPoints = ['validation.inProgress']

async inProgress(isInProgress) { ... }
```

Convention: the method name is the last segment of the extension point path (`validation.inProgress` → method `inProgress`).

### 2.8 Replace the `api` export

**If `api` was a plain object of functions**, move those functions as public methods of the class. They are callable on the class instance via `this.getDependency('pluginname')`.

**If `api` was an instance of another class** (e.g., `export const api = xmlEditor` where `xmlEditor` is a `NavXmlEditor` instance):

- Wrap it in a getter: `get editor() { return this.#editor }`
- Keep a BC re-export at the bottom of the file for modules that cannot be migrated immediately:

  ```js
  // BC: direct access to the underlying editor instance
  export const api = /** @type {XxxPlugin} */ (XxxPlugin.getInstance()).editor
  ```

- Add the `api` field to the plugin descriptor inside the class (not needed for class plugins; remove the plugin object entirely)

### 2.9 Replace cross-plugin static imports

Replace static imports of other plugins' APIs with `getDependency`. Cache dependencies that are used in more than one method as private instance fields assigned in `install()`:

```js
class XxxPlugin extends Plugin {
  /** @type {import('./logger.js').default} */
  #logger;
  /** @type {import('./client.js').api} */
  #client;

  async install(state) {
    await super.install(state);
    this.#logger = this.getDependency('logger');
    this.#client = this.getDependency('client');
    // ...
  }
}
```

For dependencies used in only one method, call `getDependency()` inline at the top of that method.

Keep imports of non-plugin utilities: `app`, `ui`, `endpoints`, `hasStateChanged`, `testLog`, `notify`, `registerTemplate`, `createFromTemplate`, etc.

### 2.10 Update state dispatch calls

```js
// Before:
import { updateState } from '../app.js'
await updateState({ key: value })

// After:
await this.dispatchStateChange({ key: value })
```

### 2.11 Update `plugins.js`

```js
// Remove the old object-plugin import:
import { plugin as xxxPlugin, api as xxx } from './plugins/xxx.js'

// The class re-export is auto-generated — do NOT add a direct import.
// Instead, run the generator (step 2.13) and then import from the registry:
import { XxxPlugin } from './plugin-registry.js'   // added by generator

// In the plugins array: replace xxxPlugin with XxxPlugin

// Remove any api re-export for this plugin — it is now exposed through the class instance via getDependency().
// Keep the BC named export if other code still imports it directly:
export const xxx = XxxPlugin.getInstance()   // was: export { xxx }
```

### 2.12 Update `plugin-registry.js`

`plugin-registry.js` is auto-generated — do not edit it manually. Run:

```sh
node bin/build.js --steps=plugins
```

This adds the re-export for the newly migrated class and updates the `PluginRegistryTypes` typedef.

### 2.13 Ensure `getDependency()` returns the correct API

For **object-based** plugin dependencies: `getDependency('xxx')` returns `plugin.api` if the descriptor has an `api` field, otherwise the plugin object itself. Ensure the descriptor includes `api`:

```js
const plugin = { name: 'config', deps: ['client'], api }
```

For **class-based** plugin dependencies: `getDependency('xxx')` calls `instance.getApi()`. The default (`Plugin.getApi()`) returns `this` (the instance). This is correct when the class's public methods ARE the API (e.g. `ConfigPlugin`). If the class wraps a separate module-level api object (e.g. `ClientPlugin`), override `getApi()`:

```js
class ClientPlugin extends Plugin {
  getApi() { return api; }  // 'api' is the module-level export
}
```

---

## Step 3: Update an existing class-based plugin to use new patterns

### 3.1 Replace `getEndpoints()` with `static extensionPoints`

If `getEndpoints()` only lists the standard lifecycle methods (`install`, `start`, `shutdown`, `onStateUpdate`, `updateInternalState`), delete it entirely — the base class auto-discovers these.

If it lists custom extension points, replace with `static extensionPoints = [...]` (see 2.7 above).

### 3.2 Split `onStateUpdate` into per-key handlers

Follow section 2.5 above.

### 3.3 Migrate `getDependency` calls

If `getDependency` is now available (framework step 1 applied), migrate static imports of other plugin APIs:

```js
// Before: import { client } from '../plugins.js'
// After: this.#client = this.getDependency('client')  (in install() or constructor)
```

---

## Step 4: Verification

1. Run `npm run build` to rebuild the bundle.
2. **Stop and ask the user to load the app** — verify no console errors before continuing.
3. Exercise the plugin's UI: all buttons/menus work, state changes are reflected correctly.
4. Run the E2E tests: `npm run test:e2e -- --grep "<plugin name>"` (if tests exist for this plugin).
5. Run `npm run test:api` to confirm no API-level regressions.
6. Verify that other plugins that previously imported this plugin's API still work (they should, via the BC re-exports).
