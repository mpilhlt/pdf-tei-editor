# TEI Enhancements Backend Plugin Implementation

Issue: <https://github.com/mpilhlt/pdf-tei-editor/issues/230>

## Overview

Migrate hardcoded TEI wizard enhancement scripts to a backend plugin architecture. Plugins that provide enhancements declare `tei-wizard` as a dependency and explicitly register their enhancement file paths via the `tei-wizard` plugin's registration API.

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

### Dependency-Based Enhancement Registration

The `tei-wizard` backend plugin serves as the central registry. Other plugins declare it as a dependency and explicitly register enhancement file paths during initialization (no auto-discovery):

```
fastapi_app/plugins/tei_wizard/          # Central registry
├── __init__.py
├── plugin.py                            # Provides register_enhancement() API
├── routes.py                            # Serves /api/plugins/tei-wizard/enhancements.js
└── enhancements/                        # Default enhancements
    ├── add-rng-schema-definition.js
    ├── pretty-print-xml.js
    └── remove-blank-lines.js

fastapi_app/plugins/my_custom_plugin/    # Plugin providing enhancements
├── __init__.py
├── plugin.py                            # Declares dependency on tei-wizard, registers paths explicitly
└── enhancements/
    └── my-enhancement.js
```

### Registration Flow

1. `tei-wizard` plugin loads first (no dependencies)
2. Dependent plugins load after, call `tei_wizard.register_enhancement(file_path, plugin_id)` during `initialize()` for each enhancement file
3. Frontend fetches `/api/plugins/tei-wizard/enhancements.js` which returns bundled, transformed enhancements

### Enhancement File Format

Enhancement files use a strictly defined ES module format that is both testable in isolation and transformable into a browser-compatible bundle:

```javascript
/**
 * @file Enhancement: Description of what this enhancement does
 */

/**
 * Human-readable name for the enhancement
 */
export const name = "My Enhancement Name";

/**
 * Description shown in the UI
 */
export const description = "What this enhancement does";

/**
 * The enhancement function. Must be a pure function that only modifies
 * the xmlDoc based on its inputs - no side effects.
 *
 * @param {Document} xmlDoc - The XML DOM Document object
 * @param {Object} currentState - The current application state
 * @param {Map<string, any>} configMap - The application configuration map
 * @returns {Document} - The modified XML DOM Document object
 */
export function execute(xmlDoc, currentState, configMap) {
  // Enhancement logic here
  return xmlDoc;
}
```

This format:
- Uses named exports (`name`, `description`, `execute`) for predictable parsing
- Is testable as a standard ES module in Node.js or browser
- Can be reliably transformed into a self-registering IIFE for browser delivery

## Implementation Plan

### Phase 1: Backend Plugin Structure

Create `fastapi_app/plugins/tei_wizard/`:

#### `plugin.py`

```python
from fastapi_app.lib.plugin_base import Plugin, PluginContext
from typing import Any
from pathlib import Path
import logging

logger = logging.getLogger(__name__)


class TeiWizardPlugin(Plugin):
    """Central registry for TEI enhancement scripts."""

    def __init__(self):
        # Store registered enhancement files: list of (path, plugin_id) tuples
        self._enhancement_files: list[tuple[Path, str]] = []

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "tei-wizard",
            "name": "TEI Wizard Enhancements",
            "description": "TEI document enhancement registry",
            "category": "enhancement",
            "version": "1.0.0",
            "required_roles": ["*"],
            "endpoints": []  # No menu entries, only API routes
        }

    def get_endpoints(self) -> dict[str, callable]:
        return {
            "list": self.list_enhancements
        }

    async def initialize(self, context: PluginContext) -> None:
        """Register default enhancements from this plugin's directory."""
        plugin_dir = Path(__file__).parent
        enhancements_dir = plugin_dir / "enhancements"

        # Explicitly register each default enhancement
        default_enhancements = [
            "add-rng-schema-definition.js",
            "pretty-print-xml.js",
            # "remove-blank-lines.js",  # Disabled - needs more testing
        ]

        for filename in default_enhancements:
            file_path = enhancements_dir / filename
            if file_path.exists():
                self.register_enhancement(file_path, "tei-wizard")

    def register_enhancement(self, file_path: Path, plugin_id: str) -> None:
        """
        Register an enhancement file from a dependent plugin.

        Args:
            file_path: Path to the JavaScript enhancement file
            plugin_id: ID of the plugin registering the enhancement
        """
        if not file_path.exists():
            logger.warning(f"Enhancement file not found: {file_path}")
            return

        # Check for duplicates by filename
        existing = [f.name for f, _ in self._enhancement_files]
        if file_path.name in existing:
            logger.warning(
                f"Enhancement {file_path.name} already registered, "
                f"replacing with version from {plugin_id}"
            )
            self._enhancement_files = [
                (f, pid) for f, pid in self._enhancement_files
                if f.name != file_path.name
            ]

        self._enhancement_files.append((file_path, plugin_id))
        logger.info(f"Registered enhancement: {file_path.name} from {plugin_id}")

    def get_enhancement_files(self) -> list[tuple[Path, str]]:
        """Return all registered enhancement files."""
        return self._enhancement_files.copy()

    async def list_enhancements(self, context, params: dict) -> dict:
        """Return metadata for all registered enhancements."""
        return {
            "enhancements": [
                {"file": f.name, "plugin_id": pid}
                for f, pid in self._enhancement_files
            ]
        }
```

#### `routes.py`

```python
from fastapi import APIRouter
from fastapi.responses import PlainTextResponse
import re
from fastapi_app.lib.plugin_manager import PluginManager

router = APIRouter(prefix="/api/plugins/tei-wizard", tags=["tei-wizard"])


def transform_to_registration(content: str, filename: str, plugin_id: str) -> str:
    """
    Transform ES module enhancement to self-registering IIFE format.

    Input (ES module with named exports):
        export const name = "...";
        export const description = "...";
        export function execute(xmlDoc, currentState, configMap) { ... }

    Output (self-registering IIFE):
        (function() {
          const name = "...";
          const description = "...";
          function execute(xmlDoc, currentState, configMap) { ... }
          window.registerTeiEnhancement({
            name: name,
            description: description,
            pluginId: "...",
            execute: execute
          });
        })();
    """
    # Remove import statements
    content = re.sub(r'^import\s+.*?;?\s*$', '', content, flags=re.MULTILINE)

    # Remove 'export' keywords from named exports
    content = re.sub(r'^export\s+const\s+', 'const ', content, flags=re.MULTILINE)
    content = re.sub(r'^export\s+function\s+', 'function ', content, flags=re.MULTILINE)

    # Remove any 'export default' statements
    content = re.sub(r'^export\s+default\s+.*?;\s*$', '', content, flags=re.MULTILINE)

    # Wrap in IIFE with registration call
    return f"""// Enhancement from plugin: {plugin_id} ({filename})
(function() {{
{content.strip()}
window.registerTeiEnhancement({{
  name: name,
  description: description,
  pluginId: "{plugin_id}",
  execute: execute
}});
}})();"""


@router.get("/enhancements.js", response_class=PlainTextResponse)
async def get_enhancements_bundle():
    """
    Return concatenated JavaScript of all registered enhancements.
    Each enhancement self-registers via window.registerTeiEnhancement().
    """
    bundle_parts = []

    plugin_manager = PluginManager.get_instance()
    tei_wizard = plugin_manager.get_plugin("tei-wizard")

    if not tei_wizard:
        return PlainTextResponse(
            content="// tei-wizard plugin not found\n",
            media_type="application/javascript"
        )

    for js_file, plugin_id in tei_wizard.get_enhancement_files():
        try:
            content = js_file.read_text()
            transformed = transform_to_registration(content, js_file.name, plugin_id)
            bundle_parts.append(transformed)
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
    console.warn(`Enhancement "${enhancement.name}" already registered, replacing`);
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

### Phase 4: Convert Enhancement Files to New Format

Convert existing enhancement files from `export default { ... }` format to the new named exports format.

Example conversion for `add-rng-schema-definition.js`:

**Before:**
```javascript
export function addRngSchemaDefinition(xmlDoc, currentState, configMap) { ... }

export default {
  name: "Add RNG Schema Definition",
  description: "...",
  execute: addRngSchemaDefinition
};
```

**After:**
```javascript
export const name = "Add RNG Schema Definition";
export const description = "...";

export function execute(xmlDoc, currentState, configMap) {
  // ... same logic as addRngSchemaDefinition
}
```

### Phase 5: Other Plugins Adding Enhancements

Plugins register enhancements by declaring `tei-wizard` as a dependency and explicitly registering each enhancement file path:

```python
# fastapi_app/plugins/my_analyzer/plugin.py

from fastapi_app.lib.plugin_base import Plugin, PluginContext
from typing import Any
from pathlib import Path


class MyAnalyzerPlugin(Plugin):
    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "my-analyzer",
            "name": "My Analyzer",
            "description": "Custom analysis plugin",
            "category": "analysis",
            "version": "1.0.0",
            "required_roles": ["*"],
            "dependencies": ["tei-wizard"]  # Declare dependency
        }

    def get_endpoints(self) -> dict[str, callable]:
        return {"analyze": self.analyze}

    async def initialize(self, context: PluginContext) -> None:
        """Register enhancements with tei-wizard."""
        tei_wizard = context.get_dependency("tei-wizard")
        if tei_wizard:
            enhancements_dir = Path(__file__).parent / "enhancements"
            # Explicitly register each enhancement - no auto-discovery
            tei_wizard.register_enhancement(
                enhancements_dir / "my-enhancement.js",
                self.metadata["id"]
            )

    async def analyze(self, context, params: dict) -> dict:
        return {"status": "ok"}
```

## Files to Create/Modify

### New Files

- `fastapi_app/plugins/tei_wizard/__init__.py`
- `fastapi_app/plugins/tei_wizard/plugin.py`
- `fastapi_app/plugins/tei_wizard/routes.py`
- `fastapi_app/plugins/tei_wizard/enhancements/*.js` (converted from frontend)
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
   - Code transformation logic (named exports to IIFE)
   - Bundle generation with multiple enhancements
2. Unit tests for `plugin.py`:
   - Enhancement registration
   - Duplicate handling
3. Unit tests for enhancement files:
   - Each enhancement file can be imported as ES module
   - Execute function works correctly
4. Integration test:
   - Plugin with `tei-wizard` dependency registers enhancements
   - Enhancements appear in `/api/plugins/tei-wizard/enhancements.js` bundle
5. E2E test:
   - Verify enhancements load and execute correctly via TEI wizard UI

## Implementation Summary

Implemented the TEI enhancement backend plugin system with dependency-based registration.

### Files Created

- [fastapi_app/plugins/tei_wizard/__init__.py](../../fastapi_app/plugins/tei_wizard/__init__.py) - Plugin module initialization
- [fastapi_app/plugins/tei_wizard/plugin.py](../../fastapi_app/plugins/tei_wizard/plugin.py) - TeiWizardPlugin class with `register_enhancement()` API
- [fastapi_app/plugins/tei_wizard/routes.py](../../fastapi_app/plugins/tei_wizard/routes.py) - `/api/plugins/tei-wizard/enhancements.js` endpoint
- [fastapi_app/plugins/tei_wizard/enhancements/add-rng-schema-definition.js](../../fastapi_app/plugins/tei_wizard/enhancements/add-rng-schema-definition.js) - Converted to new format
- [fastapi_app/plugins/tei_wizard/enhancements/pretty-print-xml.js](../../fastapi_app/plugins/tei_wizard/enhancements/pretty-print-xml.js) - Converted to new format
- [fastapi_app/plugins/tei_wizard/enhancements/remove-blank-lines.js](../../fastapi_app/plugins/tei_wizard/enhancements/remove-blank-lines.js) - Converted to new format (disabled)
- [fastapi_app/plugins/tei_wizard/tests/test_tei_wizard_plugin.py](../../fastapi_app/plugins/tei_wizard/tests/test_tei_wizard_plugin.py) - Unit tests for plugin
- [fastapi_app/plugins/tei_wizard/tests/test_tei_wizard_routes.py](../../fastapi_app/plugins/tei_wizard/tests/test_tei_wizard_routes.py) - Unit tests for routes
- [app/src/modules/enhancement-registry.js](../../app/src/modules/enhancement-registry.js) - Frontend registry with `window.registerTeiEnhancement()`
- [app/src/modules/xml-utils.js](../../app/src/modules/xml-utils.js) - Shared `prettyPrintXmlDom()` utility
- [tests/api/v1/tei_wizard_enhancements.test.js](../../tests/api/v1/tei_wizard_enhancements.test.js) - API integration tests

### Files Modified

- [app/src/plugins/tei-wizard.js](../../app/src/plugins/tei-wizard.js) - Loads enhancements dynamically from backend via `loadEnhancements()`
- [app/src/plugins/document-actions.js](../../app/src/plugins/document-actions.js) - Updated import to use `xml-utils.js`

### Key Implementation Details

1. Enhancement files use strict ES module format with named exports (`name`, `description`, `execute`)
2. The `routes.py` transforms ES modules to self-registering IIFEs by stripping `export` keywords and wrapping in IIFE
3. Frontend tei-wizard plugin loads enhancements via script tag in `loadEnhancements()` during install
4. Other plugins can register enhancements by declaring `tei-wizard` as a dependency and calling `register_enhancement()` during `initialize()`
