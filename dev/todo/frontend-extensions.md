# Frontend Extension Plugin System

Issue: Backend plugins should be able to register JavaScript files that extend frontend functionality through the application's plugin lifecycle.

## Overview

Backend plugins can register JavaScript "frontend extensions" that integrate with the application's PluginManager. These extensions:
- Participate in the standard plugin lifecycle (`install`, `start`, `onStateUpdate`)
- Can invoke endpoints on other plugins via the PluginManager
- Access application APIs through a controlled sandbox

## Architecture

### Registration Flow

1. Backend plugins register JavaScript extension files during initialization
2. `bootstrap.js` loads the extension bundle before the main app
3. Extensions self-register via `window.registerFrontendExtension()`
4. After app initialization, extensions are registered with `PluginManager`
5. Standard plugin lifecycle methods are invoked on extensions

### Extension File Format

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

### Sandbox API

The sandbox provides controlled access to application features:

```javascript
/**
 * @typedef {Object} FrontendExtensionSandbox
 * @property {import('../ui.js').namedElementsTree} ui - UI element tree
 * @property {Object} dialog - Dialog API (info, error, success, confirm, prompt)
 * @property {function(string, string, string): void} notify - Toast notifications
 * @property {function(): Object} getState - Get current application state
 * @property {function(string, any): Promise<any>} invoke - Invoke PluginManager endpoint
 * @property {Object} services - Application services (load, showMergeView)
 * @property {Object} api - API client for backend calls
 */
```

### PluginManager Integration

Extensions are wrapped as plugin objects and registered with PluginManager:

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
  ...Object.fromEntries(
    Object.entries(extension)
      .filter(([key, val]) => typeof val === 'function' && !['install', 'start', 'onStateUpdate'].includes(key))
      .map(([key, fn]) => [key, (...args) => fn(...args, sandbox)])
  )
};
```

## Implementation Plan

### Phase 1: Move plugins.py to routers/

Move `fastapi_app/routes/plugins.py` to `fastapi_app/routers/plugins.py`.

**Files:**
- Move `fastapi_app/routes/plugins.py` → `fastapi_app/routers/plugins.py`
- Update `fastapi_app/main.py` import
- Delete empty `fastapi_app/routes/` directory

### Phase 2: Create Backend Extension Registry

Create `fastapi_app/lib/frontend_extension_registry.py`:

```python
"""
Frontend Extension Registry.

Central registry for JavaScript extension files that extend frontend functionality.
Backend plugins register extensions during initialization.
"""

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


class FrontendExtensionRegistry:
    """Singleton registry for frontend extensions."""

    _instance = None

    def __init__(self):
        self._extension_files: list[tuple[Path, str]] = []

    @classmethod
    def get_instance(cls) -> "FrontendExtensionRegistry":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Reset singleton for testing."""
        cls._instance = None

    def register_extension(self, file_path: Path, plugin_id: str) -> None:
        """Register an extension file from a plugin."""
        if not file_path.exists():
            logger.warning(f"Extension file not found: {file_path}")
            return

        existing = [f.name for f, _ in self._extension_files]
        if file_path.name in existing:
            logger.warning(
                f"Extension {file_path.name} already registered, "
                f"replacing with version from {plugin_id}"
            )
            self._extension_files = [
                (f, pid) for f, pid in self._extension_files
                if f.name != file_path.name
            ]

        self._extension_files.append((file_path, plugin_id))
        logger.info(f"Registered frontend extension: {file_path.name} from {plugin_id}")

    def get_extension_files(self) -> list[tuple[Path, str]]:
        """Return all registered extension files."""
        return self._extension_files.copy()

    def clear(self) -> None:
        """Clear all registered extensions."""
        self._extension_files.clear()
```

### Phase 3: Add Extension Bundle Route

Add to `fastapi_app/routers/plugins.py`:

```python
import re
from fastapi.responses import PlainTextResponse
from fastapi_app.lib.frontend_extension_registry import FrontendExtensionRegistry


def transform_extension_to_iife(content: str, filename: str, plugin_id: str) -> str:
    """
    Transform ES module extension to self-registering IIFE format.

    Input (ES module):
        export const name = "...";
        export const deps = [...];
        export function install(state, sandbox) { ... }
        export function onStateUpdate(changedKeys, state, sandbox) { ... }

    Output (self-registering IIFE):
        (function() {
          const name = "...";
          const deps = [...];
          function install(state, sandbox) { ... }
          function onStateUpdate(changedKeys, state, sandbox) { ... }
          window.registerFrontendExtension({
            name, deps, install, onStateUpdate,
            pluginId: "..."
          });
        })();
    """
    # Remove import statements
    content = re.sub(r"^import\s+.*?;?\s*$", "", content, flags=re.MULTILINE)

    # Remove 'export' keywords
    content = re.sub(r"^export\s+const\s+", "const ", content, flags=re.MULTILINE)
    content = re.sub(r"^export\s+function\s+", "function ", content, flags=re.MULTILINE)
    content = re.sub(r"^export\s+async\s+function\s+", "async function ", content, flags=re.MULTILINE)
    content = re.sub(r"^export\s+default\s+.*?;\s*$", "", content, flags=re.MULTILINE)

    # Extract exported names for registration object
    # Find const declarations
    const_names = re.findall(r"^const\s+(\w+)\s*=", content, flags=re.MULTILINE)
    # Find function declarations
    func_names = re.findall(r"^(?:async\s+)?function\s+(\w+)\s*\(", content, flags=re.MULTILINE)

    all_exports = const_names + func_names
    exports_str = ", ".join(all_exports)

    return f"""// Frontend extension from plugin: {plugin_id} ({filename})
(function() {{
{content.strip()}
window.registerFrontendExtension({{
  {exports_str},
  pluginId: "{plugin_id}"
}});
}})();"""


@router.get("/extensions.js", response_class=PlainTextResponse)
async def get_extensions_bundle():
    """
    Return concatenated JavaScript of all registered frontend extensions.
    Each extension self-registers via window.registerFrontendExtension().
    """
    bundle_parts = []

    registry = FrontendExtensionRegistry.get_instance()

    for js_file, plugin_id in registry.get_extension_files():
        try:
            content = js_file.read_text()
            transformed = transform_extension_to_iife(content, js_file.name, plugin_id)
            bundle_parts.append(transformed)
        except Exception as e:
            bundle_parts.append(
                f"// Error loading {js_file.name} from {plugin_id}: {e}\n"
            )

    bundle = "\n\n".join(bundle_parts)

    return PlainTextResponse(content=bundle, media_type="application/javascript")
```

### Phase 4: Create Frontend Extension Registry Module

Create `app/src/modules/frontend-extension-registry.js`:

```javascript
/**
 * @file Frontend Extension Registration System.
 *
 * Extensions are loaded from backend plugins and integrated into the
 * application's PluginManager lifecycle.
 */

/**
 * @typedef {Object} FrontendExtensionDef
 * @property {string} name - Extension name (used as plugin name)
 * @property {string} [description] - Brief description
 * @property {string[]} [deps] - Dependencies on other plugins
 * @property {string} [pluginId] - Backend plugin that provided this extension
 * @property {function(Object, FrontendExtensionSandbox): void} [install] - Install function
 * @property {function(FrontendExtensionSandbox): void} [start] - Start function
 * @property {function(string[], Object, FrontendExtensionSandbox): void} [onStateUpdate] - State update handler
 */

/** @type {FrontendExtensionDef[]} */
const registeredExtensions = [];

/**
 * Register a frontend extension globally.
 * Called by dynamically loaded extension scripts.
 * @param {FrontendExtensionDef} extension
 */
function registerFrontendExtension(extension) {
  if (!extension.name) {
    console.error('Invalid extension: missing name', extension);
    return;
  }

  const existingIndex = registeredExtensions.findIndex(e => e.name === extension.name);
  if (existingIndex >= 0) {
    console.warn(`Extension "${extension.name}" already registered, replacing`);
    registeredExtensions[existingIndex] = extension;
    return;
  }

  registeredExtensions.push(extension);
  console.log(`Registered frontend extension: ${extension.name} (from ${extension.pluginId || 'unknown'})`);
}

/**
 * Get all registered extensions
 * @returns {FrontendExtensionDef[]}
 */
function getExtensions() {
  return [...registeredExtensions];
}

/**
 * Clear all registered extensions (for testing)
 */
function clearExtensions() {
  registeredExtensions.length = 0;
}

// Expose global registration function
window.registerFrontendExtension = registerFrontendExtension;

export { registerFrontendExtension, getExtensions, clearExtensions };
```

### Phase 5: Create Frontend Extension Sandbox

Create `app/src/modules/frontend-extension-sandbox.js`:

```javascript
/**
 * @file Frontend Extension Sandbox
 *
 * Provides controlled API access for frontend extensions.
 * Extensions receive this sandbox in all lifecycle methods.
 */

import ui from '../ui.js';
import { api as dialogApi } from '../plugins/dialog.js';
import { notify } from './sl-utils.js';
import { services } from '../plugins.js';
import { api } from '../plugins/client.js';

/**
 * @typedef {Object} FrontendExtensionSandbox
 * @property {import('../ui.js').namedElementsTree} ui - UI element tree
 * @property {import('../plugins/dialog.js').api} dialog - Dialog API
 * @property {function(string, string, string): void} notify - Notification function
 * @property {function(): Object} getState - Get current application state
 * @property {function(string, any, Object): Promise<any>} invoke - Invoke PluginManager endpoint
 * @property {Object} services - Application services
 * @property {Object} api - API client for backend calls
 */

/** @type {function(): Object} */
let getStateFn = () => ({});

/** @type {function(string, any, Object): Promise<any>} */
let invokeFn = async () => undefined;

/**
 * Initialize sandbox with state getter and invoke function.
 * Called by Application during initialization.
 * @param {function(): Object} stateFn - Function to get current state
 * @param {function(string, any, Object): Promise<any>} invokeFunction - PluginManager invoke function
 */
export function initializeSandbox(stateFn, invokeFunction) {
  getStateFn = stateFn;
  invokeFn = invokeFunction;
}

/**
 * Get the sandbox instance for extensions.
 * @returns {FrontendExtensionSandbox}
 */
export function getSandbox() {
  return {
    ui,
    dialog: dialogApi,
    notify,
    getState: getStateFn,
    invoke: invokeFn,
    services: {
      load: services.load,
      showMergeView: services.showMergeView
    },
    api
  };
}
```

### Phase 6: Create Extension Plugin Wrapper

Create `app/src/modules/frontend-extension-wrapper.js`:

```javascript
/**
 * @file Frontend Extension Wrapper
 *
 * Wraps frontend extensions as plugin objects for PluginManager integration.
 */

import { getExtensions } from './frontend-extension-registry.js';
import { getSandbox } from './frontend-extension-sandbox.js';

/**
 * Convert a frontend extension to a PluginManager-compatible plugin object.
 * @param {import('./frontend-extension-registry.js').FrontendExtensionDef} extension
 * @returns {Object} Plugin object for PluginManager
 */
export function wrapExtensionAsPlugin(extension) {
  const sandbox = getSandbox();

  // Standard lifecycle methods that need sandbox injection
  const lifecycleMethods = ['install', 'start', 'onStateUpdate'];

  const plugin = {
    name: extension.name,
    deps: extension.deps || [],
  };

  // Wrap lifecycle methods to inject sandbox as last argument
  if (extension.install) {
    plugin.install = (state) => extension.install(state, sandbox);
  }

  if (extension.start) {
    plugin.start = () => extension.start(sandbox);
  }

  if (extension.onStateUpdate) {
    plugin.onStateUpdate = (changedKeys, state) =>
      extension.onStateUpdate(changedKeys, state, sandbox);
  }

  // Include custom endpoints with sandbox injection
  for (const [key, value] of Object.entries(extension)) {
    if (typeof value === 'function' && !lifecycleMethods.includes(key) && key !== 'name') {
      plugin[key] = (...args) => value(...args, sandbox);
    }
  }

  return plugin;
}

/**
 * Get all extensions wrapped as plugin objects.
 * @returns {Object[]} Array of plugin objects
 */
export function getWrappedExtensions() {
  return getExtensions().map(wrapExtensionAsPlugin);
}
```

### Phase 7: Update Bootstrap to Load Extensions

Modify `app/web/bootstrap.js`:

```javascript
/**
 * Script for bootstrapping the application
 */

const loadFromSource = new URLSearchParams(window.location.search).has('dev')

window.addEventListener('DOMContentLoaded', async () => {
  if (loadFromSource) {
    // ... existing importmap and shoelace setup ...
  }

  // ... existing CSS loading ...

  // Load frontend extension registry BEFORE main app
  // This ensures window.registerFrontendExtension is available
  const extensionRegistryScript = document.createElement('script');
  extensionRegistryScript.type = 'module';
  extensionRegistryScript.textContent = `
    import '/src/modules/frontend-extension-registry.js';
  `;
  document.head.appendChild(extensionRegistryScript);

  // Load frontend extensions bundle (non-blocking, will register when ready)
  const extensionsScript = document.createElement('script');
  extensionsScript.src = '/api/v1/plugins/extensions.js';
  extensionsScript.async = true;
  document.head.appendChild(extensionsScript);

  // Load the main script as an ESM module
  const mainScript = document.createElement('script');
  mainScript.type = 'module';
  mainScript.src = loadFromSource ? '/src/app.js' : 'app.js';
  document.body.appendChild(mainScript);
})
```

### Phase 8: Update Application to Register Extensions

In `app/src/app.js`, after PluginManager setup but before `invoke('install')`:

```javascript
import { getWrappedExtensions } from './modules/frontend-extension-wrapper.js';
import { initializeSandbox } from './modules/frontend-extension-sandbox.js';

// After PluginManager is created:

// Initialize sandbox with state getter and invoke function
initializeSandbox(
  () => app.state,
  (endpoint, args, options) => app.pluginManager.invoke(endpoint, args, options)
);

// Register frontend extensions with PluginManager
// Wait a tick to ensure extension scripts have loaded
await new Promise(resolve => setTimeout(resolve, 100));

const extensions = getWrappedExtensions();
for (const extensionPlugin of extensions) {
  try {
    app.pluginManager.register(extensionPlugin);
    logger.info(`Registered frontend extension: ${extensionPlugin.name}`);
  } catch (error) {
    logger.error(`Failed to register extension ${extensionPlugin.name}:`, error);
  }
}

// Then proceed with normal plugin lifecycle
await app.pluginManager.invoke('install', [state], { mode: 'sequential' });
```

### Phase 9: Rename sample_analyzer to test_plugin

Rename `fastapi_app/plugins/sample_analyzer` → `fastapi_app/plugins/test_plugin`:

**Update plugin.py:**
- Class name: `TestPlugin`
- Metadata id: `"test-plugin"`
- Metadata name: `"Test Plugin"`
- Keep `is_available()` returning `True` only in testing mode

**Update __init__.py:**
- Update imports

### Phase 10: Add Test Extension to test_plugin

Create `fastapi_app/plugins/test_plugin/extensions/hello-world.js`:

```javascript
/**
 * @file Frontend Extension: Hello World Test
 * Adds a test button that opens a Hello World dialog.
 */

export const name = "hello-world-test";
export const description = "Adds Hello World button for testing";
export const deps = ['dialog'];

/**
 * Install the extension.
 * @param {Object} state - Initial application state
 * @param {Object} sandbox - Extension sandbox
 */
export function install(state, sandbox) {
  // Create toolbar button
  const button = document.createElement('sl-button');
  button.variant = 'text';
  button.size = 'small';
  button.innerHTML = '<sl-icon name="emoji-smile"></sl-icon>';
  button.title = 'Hello World Test';
  button.dataset.testId = 'hello-world-toolbar-btn';

  button.addEventListener('click', () => {
    sandbox.dialog.info('Hello World from frontend extension!');
  });

  // Add to toolbar
  sandbox.ui.toolbar.add(button, 0, -1);
}

/**
 * Custom endpoint - can be invoked by other plugins.
 * @param {string} greeting - Custom greeting text
 * @param {Object} sandbox
 * @returns {string}
 */
export function greet(greeting, sandbox) {
  sandbox.dialog.info(greeting || 'Hello!');
  return 'Greeting displayed';
}
```

**Update test_plugin/plugin.py:**

```python
async def initialize(self, context: PluginContext) -> None:
    """Initialize plugin and register extension."""
    # ... existing MockExtractor registration ...

    # Register frontend extension
    from fastapi_app.lib.frontend_extension_registry import FrontendExtensionRegistry

    registry = FrontendExtensionRegistry.get_instance()
    extension_dir = Path(__file__).parent / "extensions"

    extension_file = extension_dir / "hello-world.js"
    if extension_file.exists():
        registry.register_extension(extension_file, self.metadata["id"])
```

### Phase 11: Write E2E Test

Create `tests/e2e/tests/frontend-extension.spec.js`:

```javascript
import { test, expect } from '@playwright/test';
import { login, testLog, waitForAppReady } from '../e2e-helper.js';

test.describe('Frontend Extension System', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
    await login(page);
    // Wait for extensions to load and install
    await page.waitForTimeout(1000);
  });

  test('Hello World button exists in toolbar', async ({ page }) => {
    const button = page.locator('[data-test-id="hello-world-toolbar-btn"]');
    await expect(button).toBeVisible();
    testLog('Hello World button is visible in toolbar');
  });

  test('Hello World button opens dialog', async ({ page }) => {
    const button = page.locator('[data-test-id="hello-world-toolbar-btn"]');
    await button.click();

    // Wait for dialog animation
    await page.waitForTimeout(500);

    const dialog = page.locator('sl-dialog[name="dialog"]');
    await expect(dialog).toBeVisible();

    const message = dialog.locator('[name="message"]');
    await expect(message).toContainText('Hello World');

    testLog('Hello World dialog opened successfully');

    // Close dialog
    await dialog.locator('[name="closeBtn"]').click();
  });

  test('Extension can invoke other plugin endpoints', async ({ page }) => {
    // Test that extensions can use sandbox.invoke()
    const result = await page.evaluate(async () => {
      // Get the extension's greet function via PluginManager
      const manager = window.app?.pluginManager;
      if (!manager) return null;

      // Invoke the custom endpoint
      const results = await manager.invoke('greet', ['Custom greeting!']);
      return results;
    });

    // Verify the invoke worked (dialog should have shown)
    await page.waitForTimeout(500);
    const dialog = page.locator('sl-dialog[name="dialog"]');
    await expect(dialog).toBeVisible();

    testLog('Extension endpoint invocation works');
  });
});
```

### Phase 12: Add Documentation

**Add to `docs/code-assistant/backend-plugins.md`:**

```markdown
## Frontend Extensions

Backend plugins can register JavaScript files that extend frontend functionality. See [Frontend Extensions](../development/frontend-extensions.md) for detailed documentation.

Quick reference:
- Register extensions via `FrontendExtensionRegistry.register_extension(path, plugin_id)`
- Extensions integrate with PluginManager lifecycle (`install`, `start`, `onStateUpdate`)
- Use sandbox for controlled API access (`ui`, `dialog`, `notify`, `invoke`, etc.)
```

**Create `docs/development/frontend-extensions.md`:**

Full documentation covering:
- Architecture overview
- Extension file format
- Sandbox API reference
- PluginManager integration
- Custom endpoints
- Security model
- Testing extensions
- Examples

## Files to Create

- `fastapi_app/lib/frontend_extension_registry.py`
- `app/src/modules/frontend-extension-registry.js`
- `app/src/modules/frontend-extension-sandbox.js`
- `app/src/modules/frontend-extension-wrapper.js`
- `fastapi_app/plugins/test_plugin/extensions/hello-world.js`
- `tests/e2e/tests/frontend-extension.spec.js`
- `docs/development/frontend-extensions.md`

## Files to Modify

- `fastapi_app/routes/plugins.py` → `fastapi_app/routers/plugins.py` (move + add route)
- `fastapi_app/main.py` - Update import path
- `app/web/bootstrap.js` - Load extension registry and bundle
- `app/src/app.js` - Register extensions with PluginManager
- `fastapi_app/plugins/sample_analyzer/` → `fastapi_app/plugins/test_plugin/` (rename)
- `docs/code-assistant/backend-plugins.md` - Add frontend extensions reference

## Files to Delete

- `fastapi_app/routes/` directory (after moving plugins.py)

## Testing

1. **Unit tests for frontend_extension_registry.py**
2. **Unit tests for plugins.py extension route**
3. **E2E test for extension loading and lifecycle**
4. **E2E test for custom endpoint invocation**
