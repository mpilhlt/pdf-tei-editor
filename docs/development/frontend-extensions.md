# Frontend Extensions

Backend plugins can register JavaScript "frontend extensions" that integrate with the application's PluginManager as full class-based plugins. Extensions participate in the standard plugin lifecycle, can declare dependencies, use `on<Key>Change` handlers, and expose custom endpoints.

## Architecture Overview

### Registration Flow

1. Backend plugins register JavaScript extension files during initialization
2. `app.js` exposes `window.FrontendExtensionPlugin` and loads the extension bundle from `/api/v1/plugins/extensions.js`
3. Each extension IIFE calls `window.registerFrontendExtension(ClassName, pluginId)`
4. `loadExtensionsFromServer` instantiates each class via `Class.createInstance(context)` and registers it with PluginManager
5. Standard plugin lifecycle methods are invoked on extensions alongside other plugins

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `FrontendExtensionRegistry` | `fastapi_app/lib/plugins/frontend_extension_registry.py` | Backend registry for extension files |
| `frontend-extension-registry.js` | `app/src/modules/` | Frontend registry, global registration fn, extension loader |
| `frontend-extension-plugin.js` | `app/src/modules/` | `FrontendExtensionPlugin` base class |
| `module-registry.js` | `app/src/modules/` | Pre-registers utility modules as plugins |

## Extension File Format

Extensions are ES module files with a single default-exported class that extends `FrontendExtensionPlugin`. The backend transforms these to self-registering IIFEs at serve time.

```javascript
// fastapi_app/plugins/my_plugin/extensions/my-extension.js

/**
 * @import { PluginContext } from '../../../../app/src/modules/plugin-context.js'
 */

export default class MyExtension extends FrontendExtensionPlugin {
  constructor(/** @type {PluginContext} */ context) {
    super(context, { name: 'my-extension', deps: ['dialog', 'tools'] });
  }

  /**
   * Called during plugin installation.
   * @param {Object} state - Initial application state
   */
  async install(state) {
    await super.install(state);

    const button = document.createElement('sl-button');
    button.textContent = 'My Action';
    button.addEventListener('click', () => {
      this.getDependency('dialog').info('Hello from extension!');
    });
    this.getDependency('ui').toolbar.add(button, 0, -1);
  }

  /**
   * Called after all plugins are installed.
   */
  async start() {
    // Initialization that depends on other plugins being ready
  }

  /**
   * Per-key state handler — called only when state.xml changes.
   */
  async onXmlChange(newXml, prevXml) {
    // React to document change
  }

  /**
   * Custom endpoint — invocable via pluginManager.invoke('my-extension.doAction', args).
   */
  static extensionPoints = ['my-extension.doAction'];
  async doAction(args) {
    return { result: 'data' };
  }
}
```

### Naming Convention

The class name can be anything; the plugin name is set in the `super()` call. The name must be unique across all plugins.

## `FrontendExtensionPlugin` API

Extensions inherit all `Plugin` methods plus two authenticated HTTP helpers:

| Method | Description |
|--------|-------------|
| `this.callPluginApi(url, method, params)` | Call a backend plugin route with session auth. Returns parsed JSON. |
| `this.fetchText(url)` | Fetch text from a URL with session auth. Returns string. |

All other application APIs are accessed via `this.getDependency(name)`:

### Utility Modules (via `getDependency`)

These modules are pre-registered by `module-registry.js` and are always available:

| Name | Module | Common exports |
|------|--------|---------------|
| `'ui'` | `app/src/ui.js` | The UI element tree (`ui.toolbar`, `ui.pdfViewer`, etc.) |
| `'sl-utils'` | `app/src/modules/sl-utils.js` | `notify(msg, variant, icon)` and other Shoelace utilities |
| `'tei-utils'` | `app/src/modules/tei-utils.js` | `encodeXmlEntities(xml, opts)` and other TEI helpers |

To expose additional modules, add an entry to `app/src/modules/module-registry.js`.

### Plugin APIs (via `getDependency`)

| Name | Common API |
|------|-----------|
| `'dialog'` | `info`, `error`, `success`, `confirm`, `prompt` |
| `'services'` | `load(files)`, `showMergeView(diff)` |
| `'file-selection'` | `reload(options)` |
| `'sse'` | `addEventListener(type, fn)`, `removeEventListener(type, fn)` |
| `'client'` | `.apiClient` — typed API client for all `/api/v1/` endpoints |
| `'config'` | `get(key, default)` |
| `'xsl-viewer'` | `register(options)` |
| `'tools'` | `addMenuItems(items, group)` |
| `'xmleditor'` | `getXmlTree()`, `showMergeView(xml)`, etc. |

### Standard Plugin API (inherited)

| Member | Description |
|--------|-------------|
| `this.state` | Current `ApplicationState` (read-only) |
| `this.dispatchStateChange(changes)` | Dispatch state changes |
| `this.getDependency(name)` | Get another plugin's public API |
| `on<Key>Change(newVal, prevVal)` | Per-key state handler (auto-discovered) |
| `static extensionPoints = [...]` | Declare custom extension points |

## Examples

**Call a backend plugin API:**
```javascript
const data = await this.callPluginApi('/api/plugins/my-plugin/info', 'GET');
const result = await this.callPluginApi('/api/plugins/my-plugin/process', 'POST', { id: this.state.xml });
```

**Show notifications:**
```javascript
this.getDependency('sl-utils').notify('File saved', 'success', 'check-circle');
this.getDependency('sl-utils').notify('Warning', 'warning', 'exclamation-triangle');
```

**Show a dialog:**
```javascript
const confirmed = await this.getDependency('dialog').confirm('Are you sure?');
```

**Access the UI tree:**
```javascript
const ui = this.getDependency('ui');
ui.toolbar.add(myButton, 0, -1);
ui.pdfViewer.statusbar.add(widget, 'right', 3);
```

**Register an XSL stylesheet:**
```javascript
this.getDependency('xsl-viewer').register({ label: 'My View', xmlns: 'http://...', xslDoc });
```

**React to state with per-key handler:**
```javascript
async onXpathChange(newXpath) {
  this._button.disabled = !newXpath;
}
```

**Expose a custom endpoint:**
```javascript
static extensionPoints = ['my-extension.process'];

async process(args) {
  // invoked via pluginManager.invoke('my-extension.process', args)
}
```

## Registering Extensions from Backend Plugins

In the plugin class `__init__()` method (not `__init__.py`):

```python
from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from pathlib import Path

def __init__(self):
    registry = FrontendExtensionRegistry.get_instance()
    extension_file = Path(__file__).parent / "extensions" / "my-extension.js"
    if extension_file.exists():
        registry.register_extension(extension_file, self.metadata["id"])
```

### Directory Structure

```
fastapi_app/plugins/my_plugin/
├── __init__.py
├── plugin.py
└── extensions/
    └── my-extension.js
```

## Security

Extension files are validated before serving. The following patterns are blocked:

- Network access (`fetch`, `XMLHttpRequest`, `WebSocket`) — use `this.callPluginApi()` or `this.fetchText()` instead
- Dynamic code execution (`eval`, `Function` constructor)
- Dynamic imports (`import()`)
- Storage access (`localStorage`, `sessionStorage`, `indexedDB`, `cookies`)
- Window manipulation (`window.open`, `location.href`)

Extensions containing blocked patterns are skipped with a warning in the server logs.

## IIFE Transformation

The backend transforms ES module extension files to self-registering IIFEs. The transformation:

1. Strips block/line comments and `import` statements
2. Detects `export default class <Name> extends FrontendExtensionPlugin`
3. Strips `export default`, replaces `extends FrontendExtensionPlugin` → `extends window.FrontendExtensionPlugin`
4. Wraps in IIFE and appends `window.registerFrontendExtension(ClassName, "plugin_id")`

Example output:
```javascript
// Frontend extension from plugin: my_plugin (my-extension.js)
(function() {
class MyExtension extends window.FrontendExtensionPlugin {
  constructor(context) {
    super(context, { name: 'my-extension', deps: ['dialog'] });
  }
  async install(state) { ... }
}
window.registerFrontendExtension(MyExtension, "my_plugin");
})();
```

## Testing Extensions

**API test** (checks bundle transformation):
```javascript
test('Extension bundle contains class-based IIFE', async () => {
  const response = await fetch(`${API_BASE}/api/v1/plugins/extensions.js`);
  const content = await response.text();
  assert.ok(content.includes('extends window.FrontendExtensionPlugin'));
  assert.ok(content.includes('window.registerFrontendExtension(MyExtension'));
});
```

**E2E test** (checks runtime behaviour):
```javascript
test('Extension button exists in toolbar', async ({ page }) => {
  await page.goto('/');
  await performLogin(page);
  await page.waitForTimeout(1000); // Wait for extensions to load

  const button = page.locator('[data-test-id="my-button"]');
  await expect(button).toBeVisible();
});

test('Extension custom endpoint is invocable', async ({ page }) => {
  await page.evaluate(async () => {
    await window.app.invokePluginEndpoint('my-extension.doAction', ['arg']);
  });
});
```

## Migration from Function-Based Extensions

Old function-based extension format (removed):

| Old (sandbox pattern) | New (class pattern) |
|-----------------------|---------------------|
| `export const name = "x"` | `super(context, { name: 'x', deps: [...] })` |
| `export async function install(state, sandbox)` | `async install(state) { await super.install(state); ... }` |
| `export async function start(sandbox)` | `async start() { ... }` |
| `export function onStateUpdate(changedKeys, state, sandbox)` | `async on<Key>Change(newVal, prevVal)` methods |
| `let _moduleVar` | `this._instanceVar` |
| `sandbox.updateState(x)` | `this.dispatchStateChange(x)` |
| `sandbox.getState()` | `this.state` |
| `sandbox.callPluginApi(...)` | `this.callPluginApi(...)` |
| `sandbox.fetchText(...)` | `this.fetchText(...)` |
| `sandbox.getDependency('x')` | `this.getDependency('x')` |
| `sandbox.ui` | `this.getDependency('ui')` |
| `sandbox.notify(...)` | `this.getDependency('sl-utils').notify(...)` |
| `sandbox.teiUtils` | `this.getDependency('tei-utils')` |
| `sandbox.services.load(f)` | `this.getDependency('services').load(f)` |
| `sandbox.services.reloadFiles(o)` | `this.getDependency('file-selection').reload(o)` |
| `sandbox.sse.addEventListener(...)` | `this.getDependency('sse').addEventListener(...)` |
| `sandbox.api.X()` | `this.getDependency('client').apiClient.X()` |
| `sandbox.config.get(...)` | `this.getDependency('config').get(...)` |
| `sandbox.registerXslStylesheet(opts)` | `this.getDependency('xsl-viewer').register(opts)` |
| `export function X(args, sandbox)` | Class method + `static extensionPoints = ['name.X']` |
