# Frontend Extensions

Backend plugins can register JavaScript "frontend extensions" that integrate with the application's PluginManager. These extensions participate in the standard plugin lifecycle and can interact with other plugins via the PluginManager.

## Architecture Overview

### Registration Flow

1. Backend plugins register JavaScript extension files during initialization
2. `app.js` loads the extension bundle from `/api/v1/plugins/extensions.js`
3. Extensions self-register via `window.registerFrontendExtension()`
4. Extensions are wrapped as plugin objects and registered with `PluginManager`
5. Standard plugin lifecycle methods are invoked on extensions

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `FrontendExtensionRegistry` | `fastapi_app/lib/frontend_extension_registry.py` | Backend registry for extension files |
| `frontend-extension-registry.js` | `app/src/modules/` | Frontend registry and global registration function |
| `frontend-extension-sandbox.js` | `app/src/modules/` | Controlled API access for extensions |
| `frontend-extension-wrapper.js` | `app/src/modules/` | Wraps extensions as PluginManager plugins |

## Extension File Format

Extensions use ES module format with named exports matching PluginManager endpoints:

```javascript
/**
 * @file Frontend Extension: Description
 */

export const name = "my-extension";
export const description = "What this extension does";
export const deps = ['dialog']; // Optional: dependencies on other plugins

/**
 * Called during plugin installation phase.
 * @param {Object} state - Initial application state
 * @param {FrontendExtensionSandbox} sandbox - Sandbox with controlled API access
 */
export function install(state, sandbox) {
  // Add UI elements, set up handlers, etc.
  const button = document.createElement('sl-button');
  button.textContent = 'My Action';
  button.addEventListener('click', () => {
    sandbox.dialog.info('Hello from extension!');
  });
  sandbox.ui.toolbar.add(button, 0, -1);
}

/**
 * Called after all plugins are installed.
 * @param {FrontendExtensionSandbox} sandbox
 */
export function start(sandbox) {
  // Initialization that depends on other plugins being ready
}

/**
 * Called when application state changes.
 * @param {string[]} changedKeys - Keys that changed
 * @param {Object} state - Current state
 * @param {FrontendExtensionSandbox} sandbox
 */
export function onStateUpdate(changedKeys, state, sandbox) {
  if (changedKeys.includes('user')) {
    // React to state changes
  }
}

/**
 * Custom endpoint - can be invoked by other plugins.
 * @param {any} args - Arguments from invoker
 * @param {FrontendExtensionSandbox} sandbox
 */
export function customAction(args, sandbox) {
  return { result: 'data' };
}
```

## Sandbox API

The sandbox provides controlled access to application features:

| Property | Type | Description |
|----------|------|-------------|
| `ui` | Object | UI element tree (same as global `ui` object) |
| `dialog` | Object | Dialog API (`info`, `error`, `success`, `confirm`, `prompt`) |
| `notify` | Function | Toast notifications: `notify(message, variant, icon)` |
| `getState` | Function | Get current application state |
| `invoke` | Function | Invoke PluginManager endpoint |
| `services` | Object | Application services (`load`, `showMergeView`) |
| `api` | Object | API client for backend calls |

### Examples

**Show dialog:**
```javascript
sandbox.dialog.info('Information message');
sandbox.dialog.error('Error message');
const confirmed = await sandbox.dialog.confirm('Are you sure?');
const name = await sandbox.dialog.prompt('Enter name:', 'Input');
```

**Show notification:**
```javascript
sandbox.notify('File saved', 'success', 'check-circle');
sandbox.notify('Warning', 'warning', 'exclamation-triangle');
```

**Invoke another plugin endpoint:**
```javascript
const results = await sandbox.invoke('endpoint-name', [arg1, arg2]);
```

**Access application state:**
```javascript
const state = sandbox.getState();
if (state.xml) {
  // Document is loaded
}
```

## Registering Extensions from Backend Plugins

In your plugin's `initialize()` method:

```python
from fastapi_app.lib.frontend_extension_registry import FrontendExtensionRegistry
from pathlib import Path

async def initialize(self, context: PluginContext) -> None:
    registry = FrontendExtensionRegistry.get_instance()
    extension_dir = Path(__file__).parent / "extensions"

    extension_file = extension_dir / "my-extension.js"
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

Extension files are validated before being served. The following patterns are blocked:

- Network access (`fetch`, `XMLHttpRequest`, `WebSocket`)
- Dynamic code execution (`eval`, `Function` constructor)
- Dynamic imports (`import()`)
- Storage access (`localStorage`, `sessionStorage`, `indexedDB`, `cookies`)
- Window manipulation (`window.open`, `location.href`)

Extensions that contain blocked patterns will be skipped with a warning in the server logs.

## PluginManager Integration

Extensions are wrapped as plugin objects with sandbox injection:

```javascript
// Extension wrapper creates a plugin object
const extensionPlugin = {
  name: extension.name,
  deps: extension.deps || [],

  // Wrap install to inject sandbox
  install: (state) => extension.install?.(state, sandbox),

  // Wrap start to inject sandbox
  start: () => extension.start?.(sandbox),

  // Wrap onStateUpdate to inject sandbox
  onStateUpdate: (changedKeys, state) =>
    extension.onStateUpdate?.(changedKeys, state, sandbox),

  // Include any custom endpoints
  customEndpoint: (...args) => extension.customEndpoint(...args, sandbox)
};
```

## Testing Extensions

E2E tests can verify extension functionality:

```javascript
test('Extension button exists', async ({ page }) => {
  await page.goto('/');
  await performLogin(page);
  await page.waitForTimeout(1000); // Wait for extensions

  const button = page.locator('[data-test-id="my-button"]');
  await expect(button).toBeVisible();
});

test('Extension endpoint can be invoked', async ({ page }) => {
  await page.goto('/');
  await performLogin(page);

  const result = await page.evaluate(async () => {
    const app = window.app;
    return await app.pluginManager.invoke('customAction', ['arg']);
  });

  expect(result).toBeDefined();
});
```

## Differences from Backend Plugin Sandbox

| Feature | Frontend Extension Sandbox | Backend Plugin Sandbox |
|---------|---------------------------|------------------------|
| Purpose | Direct API access for extensions in main window | Inter-window communication for plugin HTML in iframes |
| Location | `frontend-extension-sandbox.js` | `backend-plugin-sandbox.js` |
| Communication | Direct function calls | postMessage-based |
| Use case | Extensions from backend plugins | Plugin result dialogs, custom routes |

The Frontend Extension Sandbox provides direct API access for JavaScript extensions that run in the main application window. The Backend Plugin Sandbox handles communication between the main window and plugin-generated HTML displayed in iframes or popup windows.

## Implementation Summary

### Files Created

| File | Purpose |
| ---- | ------- |
| `fastapi_app/lib/frontend_extension_registry.py` | Backend singleton registry for extension files |
| `app/src/modules/frontend-extension-registry.js` | Frontend registry with `window.registerFrontendExtension()` and `loadExtensionsFromServer()` |
| `app/src/modules/frontend-extension-sandbox.js` | Sandbox providing controlled API access for extensions |
| `app/src/modules/frontend-extension-wrapper.js` | Wraps extensions as PluginManager-compatible plugin objects |
| `fastapi_app/plugins/test_plugin/extensions/hello-world.js` | Example extension demonstrating the system |
| `tests/e2e/tests/frontend-extension.spec.js` | E2E tests for extension loading and functionality |

### Files Modified

| File | Changes |
| ---- | ------- |
| `fastapi_app/lib/plugin_tools.py` | Added `validate_javascript_content()` for security validation |
| `fastapi_app/routers/plugins.py` | Added `/extensions.js` endpoint with IIFE transformation |
| `fastapi_app/plugins/tei_wizard/routes.py` | Added validation for enhancement files |
| `app/src/app.js` | Added extension loading via `loadExtensionsFromServer()` |
| `fastapi_app/plugins/sample_analyzer/` | Renamed to `test_plugin/` with frontend extension support |
| `docs/code-assistant/backend-plugins.md` | Added Frontend Extensions section |

### Key Implementation Details

1. **ES Module to IIFE Transformation**: The backend transforms ES module extensions to self-registering IIFEs that call `window.registerFrontendExtension()`.

2. **Security Validation**: JavaScript content is validated for dangerous patterns (network access, eval, storage) before serving. Invalid extensions are skipped with warnings.

3. **Sandbox Injection**: All extension lifecycle methods receive a sandbox object as their last argument, providing controlled access to application APIs.

4. **PluginManager Integration**: Extensions are wrapped as plugin objects and registered with the PluginManager, participating in the standard `install`, `start`, and `onStateUpdate` lifecycle.

5. **Loading Flow**: Extensions are loaded synchronously during app initialization (before `installPlugins()`) to ensure they participate in the full plugin lifecycle.
