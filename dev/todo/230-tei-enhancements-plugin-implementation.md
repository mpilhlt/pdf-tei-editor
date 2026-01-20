# TEI Enhancements Backend Plugin Implementation

Issue: https://github.com/mpilhlt/pdf-tei-editor/issues/230

## Overview

Migrate hardcoded TEI wizard enhancement scripts to a backend plugin architecture, allowing dynamic registration based on active plugins. The tei-wizard backend plugin serves as a central registry that discovers and aggregates enhancements from all backend plugins.

## Current State

### Frontend Enhancement System
- Enhancements defined in `app/src/plugins/tei-wizard/enhancements/` directory
- Manifest file at `app/src/plugins/tei-wizard/enhancements.js` imports and exports all enhancements
- TEI wizard plugin (`app/src/plugins/tei-wizard.js`) imports enhancements at build time
- Enhancement signature: `(xmlDoc: Document, currentState: ApplicationState, configMap: Map) => Document`

### Existing Enhancements
1. `add-rng-schema-definition.js` - Replaces schema declarations with RNG schema processing instruction
2. `pretty-print-xml.js` - Pretty-prints XML DOM by inserting whitespace text nodes
3. `remove-blank-lines.js` - Removes blank lines (currently disabled)

## Architecture

### Enhancement Discovery Pattern

Each backend plugin can provide enhancements by placing JavaScript files in an `enhancements/` subdirectory:

```
fastapi_app/plugins/<plugin_id>/
├── __init__.py
├── plugin.py
└── enhancements/           # Optional: enhancement scripts
    ├── enhancement-a.js
    └── enhancement-b.js
```

The tei-wizard plugin discovers all enhancements across all plugins at runtime:

```
GET /api/plugins/tei-wizard/enhancements.js
```

This endpoint scans all registered plugins for `enhancements/` directories and concatenates their scripts.

## Implementation Plan

### Phase 1: Backend Plugin Structure

Create `fastapi_app/plugins/tei_wizard/` with:

```
fastapi_app/plugins/tei_wizard/
├── __init__.py
├── plugin.py
├── routes.py
└── enhancements/           # Default enhancements (moved from frontend)
    ├── add-rng-schema-definition.js
    ├── pretty-print-xml.js
    └── remove-blank-lines.js
```

#### `plugin.py`

```python
from fastapi_app.lib.plugin_base import Plugin
from fastapi_app.lib.plugin_manager import PluginManager
from typing import Any
from pathlib import Path

class TeiWizardPlugin(Plugin):
    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "tei-wizard",
            "name": "TEI Wizard Enhancements",
            "description": "TEI document enhancement registry and default scripts",
            "category": "enhancement",
            "version": "1.0.0",
            "required_roles": ["*"]
        }

    def get_endpoints(self) -> dict[str, callable]:
        return {
            "list": self.list_enhancements
        }

    async def list_enhancements(self, context, params: dict) -> dict:
        """Return metadata for all enhancements from all plugins."""
        return {"enhancements": self.discover_all_enhancements()}

    @staticmethod
    def discover_all_enhancements() -> list[dict]:
        """
        Discover enhancement scripts from all registered plugins.
        Each plugin can have an enhancements/ directory with .js files.
        """
        enhancements = []
        plugin_manager = PluginManager.get_instance()

        for plugin in plugin_manager.get_all_plugins():
            plugin_dir = Path(plugin.__class__.__module__.replace('.', '/')).parent
            # Handle both relative and absolute paths
            if not plugin_dir.is_absolute():
                import fastapi_app
                plugin_dir = Path(fastapi_app.__file__).parent.parent / plugin_dir

            enhancements_dir = plugin_dir / "enhancements"

            if enhancements_dir.exists() and enhancements_dir.is_dir():
                for js_file in sorted(enhancements_dir.glob("*.js")):
                    enhancements.append({
                        "file": js_file.name,
                        "plugin_id": plugin.metadata["id"],
                        "path": str(js_file)
                    })

        return enhancements
```

#### `routes.py`

```python
from fastapi import APIRouter
from fastapi.responses import PlainTextResponse
from pathlib import Path
import re
from fastapi_app.lib.plugin_manager import PluginManager

router = APIRouter(prefix="/api/plugins/tei-wizard", tags=["tei-wizard"])

def sanitize_enhancement_code(code: str) -> str:
    """
    Replace potentially dangerous global objects with safe alternatives.
    Lightweight sanitation for trusted plugin code.
    """
    dangerous_patterns = [
        (r'\bfetch\s*\(', 'throw new Error("fetch() is not allowed in enhancement functions"); ('),
        (r'\bXMLHttpRequest\b', '(function(){throw new Error("XMLHttpRequest is not allowed")})()'),
        (r'\bWebSocket\b', '(function(){throw new Error("WebSocket is not allowed")})()'),
        (r'\bEventSource\b', '(function(){throw new Error("EventSource is not allowed")})()'),
        (r'\blocalStorage\b', '(function(){throw new Error("localStorage is not allowed")})()'),
        (r'\bsessionStorage\b', '(function(){throw new Error("sessionStorage is not allowed")})()'),
        (r'\bindexedDB\b', '(function(){throw new Error("indexedDB is not allowed")})()'),
        (r'\beval\s*\(', 'throw new Error("eval() is not allowed"); ('),
        (r'\bFunction\s*\(', 'throw new Error("Function() constructor is not allowed"); ('),
    ]

    sanitized = code
    for pattern, replacement in dangerous_patterns:
        sanitized = re.sub(pattern, replacement, sanitized)

    return sanitized


def transform_to_registration(content: str, filename: str, plugin_id: str) -> str:
    """
    Transform ES module enhancement to self-registering format.

    Input (ES module):
        export default {
          name: "...",
          description: "...",
          execute: function(xmlDoc, currentState, configMap) { ... }
        };

    Output (self-registering):
        (function() {
          window.registerTeiEnhancement({
            name: "...",
            description: "...",
            pluginId: "...",
            execute: function(xmlDoc, currentState, configMap) { ... }
          });
        })();
    """
    # Remove ES module imports (they reference frontend paths)
    content = re.sub(r'^import\s+.*?;?\s*$', '', content, flags=re.MULTILINE)

    # Find and extract the default export
    default_match = re.search(
        r'export\s+default\s+(\{[\s\S]*?\});?\s*$',
        content,
        re.MULTILINE
    )

    if default_match:
        enhancement_obj = default_match.group(1)

        # Inject pluginId into the enhancement object
        # Insert after the opening brace
        enhancement_obj = enhancement_obj.replace(
            '{',
            f'{{\n  pluginId: "{plugin_id}",',
            1
        )

        # Get any preceding function definitions needed
        preceding_code = content[:default_match.start()].strip()

        return f"""// Enhancement from plugin: {plugin_id} ({filename})
(function() {{
{preceding_code}
window.registerTeiEnhancement({enhancement_obj});
}})();"""

    return f"// Could not transform {filename} from {plugin_id}\n"


def discover_enhancement_files() -> list[tuple[Path, str]]:
    """
    Discover all enhancement files from all registered plugins.
    Returns list of (file_path, plugin_id) tuples.
    """
    enhancement_files = []
    plugin_manager = PluginManager.get_instance()

    for plugin in plugin_manager.get_all_plugins():
        plugin_module = plugin.__class__.__module__
        # Convert module path to file path
        import importlib
        module = importlib.import_module(plugin_module)
        plugin_dir = Path(module.__file__).parent

        enhancements_dir = plugin_dir / "enhancements"

        if enhancements_dir.exists() and enhancements_dir.is_dir():
            for js_file in sorted(enhancements_dir.glob("*.js")):
                enhancement_files.append((js_file, plugin.metadata["id"]))

    return enhancement_files


@router.get("/enhancements.js", response_class=PlainTextResponse)
async def get_enhancements_bundle():
    """
    Return concatenated JavaScript of all registered enhancements from all plugins.
    Each enhancement self-registers via window.registerTeiEnhancement().
    """
    bundle_parts = []

    for js_file, plugin_id in discover_enhancement_files():
        try:
            content = js_file.read_text()
            transformed = transform_to_registration(content, js_file.name, plugin_id)
            sanitized = sanitize_enhancement_code(transformed)
            bundle_parts.append(sanitized)
        except Exception as e:
            bundle_parts.append(f"// Error loading {js_file.name} from {plugin_id}: {e}\n")

    bundle = "\n\n".join(bundle_parts)

    return PlainTextResponse(
        content=bundle,
        media_type="application/javascript"
    )
```

#### `__init__.py`

```python
from .plugin import TeiWizardPlugin

plugin = TeiWizardPlugin()
```

### Phase 2: Frontend Registration API

#### Create `app/src/modules/enhancement-registry.js`

```javascript
/**
 * @file Global TEI enhancement registration system.
 * Enhancements are loaded dynamically from the backend plugin system.
 */

/**
 * @import { ApplicationState } from '../state.js'
 */

/**
 * Enhancement execute function signature
 * @typedef {function(Document, ApplicationState, Map<string, any>): Document} EnhancementExecuteFunction
 */

/**
 * @typedef {Object} EnhancementDef
 * @property {string} name - The name of the enhancement
 * @property {string} description - A brief description
 * @property {string} [pluginId] - The backend plugin that provided this enhancement
 * @property {EnhancementExecuteFunction} execute - The function to execute
 */

/** @type {EnhancementDef[]} */
const registeredEnhancements = [];

/**
 * Register a TEI enhancement globally.
 * Called by dynamically loaded enhancement scripts from backend plugins.
 * @param {EnhancementDef} enhancement
 */
function registerTeiEnhancement(enhancement) {
  if (!enhancement.name || !enhancement.execute) {
    console.error('Invalid enhancement: missing name or execute function', enhancement);
    return;
  }

  // Prevent duplicate registration
  const existingIndex = registeredEnhancements.findIndex(e => e.name === enhancement.name);
  if (existingIndex >= 0) {
    console.warn(`Enhancement "${enhancement.name}" already registered, replacing with version from ${enhancement.pluginId || 'unknown'}`);
    registeredEnhancements[existingIndex] = enhancement;
    return;
  }

  registeredEnhancements.push(enhancement);
  console.log(`Registered TEI enhancement: ${enhancement.name} (from ${enhancement.pluginId || 'unknown'})`);
}

/**
 * Get all registered enhancements
 * @returns {EnhancementDef[]}
 */
function getEnhancements() {
  return [...registeredEnhancements];
}

/**
 * Clear all registered enhancements (useful for testing)
 */
function clearEnhancements() {
  registeredEnhancements.length = 0;
}

// Expose global registration function for dynamically loaded scripts
window.registerTeiEnhancement = registerTeiEnhancement;

export { registerTeiEnhancement, getEnhancements, clearEnhancements };
```

### Phase 3: Update Frontend Loading

#### Modify `app/web/bootstrap.js`

Add enhancement script loading after app initialization:

```javascript
// After existing bootstrap code, load enhancements from all plugins
const enhancementsScript = document.createElement('script');
enhancementsScript.src = '/api/plugins/tei-wizard/enhancements.js';
enhancementsScript.async = false;  // Ensure loaded before app needs them
document.head.appendChild(enhancementsScript);
```

#### Update `app/src/plugins/tei-wizard.js`

Replace static import with dynamic registry:

```javascript
// Remove this:
// import enhancements from './tei-wizard/enhancements.js';

// Add this:
import { getEnhancements } from '../modules/enhancement-registry.js';

// In install() and elsewhere, use:
const enhancements = getEnhancements();
```

### Phase 4: Move Default Enhancement Files

1. Copy enhancement JS files from `app/src/plugins/tei-wizard/enhancements/` to `fastapi_app/plugins/tei_wizard/enhancements/`
2. Modify files to work in both contexts (ES module for dev, transformed for production)
3. Remove TypeScript-style imports that reference frontend paths (these will be unavailable in the transformed version)

### Phase 5: Other Plugins Adding Enhancements

Any backend plugin can provide enhancements by adding an `enhancements/` directory:

```
fastapi_app/plugins/my_custom_plugin/
├── __init__.py
├── plugin.py
└── enhancements/
    └── my-custom-enhancement.js
```

Enhancement file format:

```javascript
/**
 * @file Enhancement: My Custom Enhancement
 */

/**
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {Object} currentState - The current application state
 * @param {Map<string, any>} configMap - The application configuration map
 * @returns {Document} - The modified XML DOM Document object
 */
function myCustomEnhancement(xmlDoc, currentState, configMap) {
  // Enhancement logic here
  // MUST be pure: only produce output from inputs, no side effects
  return xmlDoc;
}

export default {
  name: "My Custom Enhancement",
  description: "What this enhancement does",
  execute: myCustomEnhancement
};
```

### Phase 6: Security Considerations

The sanitization function in `routes.py` blocks:
- Network APIs: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`
- Storage APIs: `localStorage`, `sessionStorage`, `indexedDB`
- Code execution: `eval()`, `Function()` constructor

This is a lightweight approach appropriate for trusted plugin code. Enhancements are provided by backend plugins, not user-uploaded code.

## Files to Create/Modify

### New Files
- `fastapi_app/plugins/tei_wizard/__init__.py`
- `fastapi_app/plugins/tei_wizard/plugin.py`
- `fastapi_app/plugins/tei_wizard/routes.py`
- `fastapi_app/plugins/tei_wizard/enhancements/*.js` (moved from frontend)
- `app/src/modules/enhancement-registry.js`

### Modified Files
- `app/web/bootstrap.js` - Add enhancement script loading
- `app/src/plugins/tei-wizard.js` - Use dynamic registry instead of static import

### Deprecated Files (to be removed after migration)
- `app/src/plugins/tei-wizard/enhancements.js`
- `app/src/plugins/tei-wizard/enhancements/*.js`

## Dependencies

The `prettyPrintXmlDom` function is also used by `document-actions.js`:

```javascript
import { prettyPrintXmlDom } from './tei-wizard/enhancements/pretty-print-xml.js'
```

Options:
1. Keep a copy of the utility function in the frontend (separate from the enhancement)
2. Create a shared utility module `app/src/modules/xml-utils.js` for functions used both as enhancements and elsewhere

## Testing

1. Unit tests for `routes.py`:
   - Code transformation logic
   - Sanitization blocks dangerous operations
   - Enhancement discovery across multiple plugins
2. E2E test:
   - Verify enhancements load from `/api/plugins/tei-wizard/enhancements.js`
   - Verify enhancements execute correctly via TEI wizard
3. Integration test:
   - Add test enhancement to sample_analyzer plugin
   - Verify it appears in the aggregated bundle
