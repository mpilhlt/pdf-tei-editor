# Backend Plugin System

Technical guide for creating backend plugins in the PDF-TEI Editor.

## Architecture

Backend plugins are Python modules discovered at runtime from:
- `fastapi_app/plugins/<plugin_id>/`
- Paths in `FASTAPI_PLUGIN_PATHS` environment variable (colon-separated)

Each plugin:
- Inherits from `fastapi_app.lib.plugin_base.Plugin`
- Defines metadata (id, name, description, category, version, required_roles)
- Implements endpoints as async methods
- Has access to `PluginContext` for app state and user info

## Creating a Plugin

### Directory Structure

**Use underscores in directory names** (not hyphens) to avoid Python import issues:

```
fastapi_app/plugins/my_plugin/
├── __init__.py
├── plugin.py          # Main plugin class
└── routes.py          # Optional custom routes
```

### Minimal Plugin

```python
# plugin.py
from fastapi_app.lib.plugin_base import Plugin
from typing import Any

class MyPlugin(Plugin):
    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "my-plugin",
            "name": "My Plugin",
            "description": "What it does",
            "category": "analyzer",  # Used for UI grouping
            "version": "1.0.0",
            "required_roles": ["user"]  # or ["*"] for all
        }

    def get_endpoints(self) -> dict[str, callable]:
        return {
            "execute": self.execute,
            "info": self.get_info
        }

    async def execute(self, context, params: dict) -> dict:
        """Main execution endpoint"""
        # Access user: context.user
        # Access app: context.app
        return {"result": "data"}

    async def get_info(self, context, params: dict) -> dict:
        """Info endpoint"""
        return {"plugin": self.metadata["id"]}
```

### Plugin Registration

In `__init__.py`:

```python
from .plugin import MyPlugin

plugin = MyPlugin()
```

## Conditional Availability

Plugins can define runtime availability conditions using the `is_available()` class method. This allows plugins to be conditionally loaded based on:

- Environment variables (e.g., application mode)
- External dependencies
- Configuration settings
- System capabilities

```python
import os
from fastapi_app.lib.plugin_base import Plugin

class MyPlugin(Plugin):
    # ... metadata and endpoints ...

    @classmethod
    def is_available(cls) -> bool:
        """Only available in development and testing modes."""
        app_mode = os.environ.get("FASTAPI_APPLICATION_MODE", "development")
        return app_mode in ("development", "testing")
```

**When to Use:**

- Development/testing-only plugins (like sample_analyzer)
- Plugins requiring optional external services
- Feature-flagged functionality
- Environment-specific tools

**Behavior:**

- Unavailable plugins are skipped during discovery (not registered)
- Default implementation returns `True` (always available)
- Checked once at startup during plugin discovery

**Example - Mock Extractor Pattern:**

Similar to [mock_extractor.py](../../fastapi_app/extractors/mock_extractor.py):

```python
@classmethod
def is_available(cls) -> bool:
    """Available only in testing mode."""
    app_mode = os.environ.get("FASTAPI_APPLICATION_MODE", "development")
    return app_mode == "testing"
```

## Role-Based Access

- `required_roles: ["admin"]` - Only admin users
- `required_roles: ["user"]` - Any authenticated user
- `required_roles: ["*"]` - Everyone (including anonymous)
- `required_roles: []` - Everyone (including anonymous)

Wildcard `*` in user roles grants access to all plugins.

## Frontend Integration

Plugins appear in toolbar dropdown, organized by category. Frontend calls:

```javascript
// List plugins (role-filtered)
const plugins = await api.getBackendPlugins();

// Execute plugin
const result = await api.executeBackendPlugin(
  'my-plugin',
  'execute',
  { param: 'value' }
);
```

### Multi-Endpoint Menu Support

Plugins can define multiple menu entries, each calling a different endpoint with different parameters from the application state:

```python
@property
def metadata(self) -> dict[str, Any]:
    return {
        "id": "my-analyzer",
        "name": "Document Analyzer",
        "description": "Analyzes documents",
        "version": "1.0.0",
        "category": "analyzer",
        "required_roles": ["user"],
        "endpoints": [
            {
                "name": "analyze",
                "label": "Analyze Current XML",
                "description": "Analyze currently open XML document",
                "state_params": ["xml", "variant"]
            },
            {
                "name": "analyze_all",
                "label": "Analyze All Documents",
                "description": "Run analysis on all documents",
                "state_params": []
            },
            {
                "name": "info",
                "label": "Plugin Info",
                "description": "Get plugin information",
                "state_params": []
            }
        ]
    }
```

**Endpoint Definition Fields:**

- `name` (required): Endpoint method name (must match key in `get_endpoints()`)
- `label` (required): Display label for menu item
- `description` (optional): Tooltip text
- `state_params` (required): List of state fields to pass as parameters (see [app/src/state.js](../../app/src/state.js))

**Available State Parameters:**

- `pdf` - PDF document ID
- `xml` - XML document ID
- `diff` - Diff XML document ID
- `xpath` - Current XPath selection
- `variant` - Variant filter
- `collection` - Current collection ID
- Other fields from `ApplicationState` typedef

**Backward Compatibility:**

- If `endpoints` not defined: Single menu item calls `execute` endpoint
- If `endpoints` is empty array: Plugin appears in list but adds no menu items

**Example with State Parameters:**

```python
async def analyze(self, context, params: dict) -> dict:
    """Analyze XML document from state parameters"""
    xml_id = params.get("xml")  # Passed from frontend state
    variant = params.get("variant")  # Passed from frontend state

    if xml_id:
        # Load and analyze the XML file
        from fastapi_app.lib.dependencies import get_db, get_file_storage
        from fastapi_app.lib.file_repository import FileRepository

        db = get_db()
        file_repo = FileRepository(db)
        file_storage = get_file_storage()

        file_metadata = file_repo.get_file_by_id_or_stable_id(xml_id)
        if file_metadata and file_metadata.file_type == "tei":
            content_bytes = file_storage.read_file(file_metadata.id, "tei")
            text = content_bytes.decode("utf-8")
            # Perform analysis on text
            return {"analysis": "result"}

    return {"error": "No XML document open"}
```

## API Endpoints

- `GET /api/v1/plugins` - List plugins (filtered by user roles)
- `POST /api/v1/plugins/{plugin_id}/execute` - Execute endpoint

Request body:
```json
{
  "endpoint": "execute",
  "params": {"key": "value"}
}
```

## Custom Routes (Optional)

Add `routes.py` for custom FastAPI routes. Plugin routes use the unversioned `/api/plugins` prefix:

```python
from fastapi import APIRouter

# Router prefix uses unversioned /api/plugins
router = APIRouter(prefix="/api/plugins/my-plugin", tags=["my-plugin"])

@router.get("/custom")
async def custom_route():
    return {"custom": "data"}
```

This creates the endpoint at `/api/plugins/my-plugin/custom`.

**Path Requirements:**

- Router prefix should be `/api/plugins/{plugin-id}` (unversioned)
- The router is registered directly on the app (not under the versioned api_v1 router)
- Plugin routes are unversioned and independent of the main API versioning
- Plugin routes are excluded from the generated API client (`api-client-v1.js`)

**Frontend Access:**

Plugin routes should be called using the `callPluginApi` method from `BackendPluginsPlugin`, not the main `callApi` function:

```javascript
// In a plugin or component that has access to BackendPluginsPlugin
const backendPluginsPlugin = /* get BackendPluginsPlugin instance */;

// GET request with query params
const response = await backendPluginsPlugin.callPluginApi(
  '/api/plugins/my-plugin/custom',
  'GET',
  { param1: 'value1', param2: 'value2' }
);

// POST request with JSON body
const response = await backendPluginsPlugin.callPluginApi(
  '/api/plugins/my-plugin/action',
  'POST',
  { data: 'value' }
);

// Handle different response types
const jsonData = await response.json();  // For JSON responses
const blob = await response.blob();      // For file downloads
const text = await response.text();      // For text responses
```

The `callPluginApi` method:

- Automatically adds authentication headers (`X-Session-ID`)
- Handles query parameters for GET requests
- Handles JSON body for POST/PUT/etc requests
- Returns the raw `Response` object for flexible response handling
- Throws errors for non-OK responses

## Key Files

- [fastapi_app/lib/plugin_base.py](../../fastapi_app/lib/plugin_base.py) - Base classes
- [fastapi_app/lib/plugin_registry.py](../../fastapi_app/lib/plugin_registry.py) - Discovery
- [fastapi_app/lib/plugin_manager.py](../../fastapi_app/lib/plugin_manager.py) - Lifecycle
- [fastapi_app/routes/plugins.py](../../fastapi_app/routes/plugins.py) - API routes
- [app/src/plugins/backend-plugins.js](../../app/src/plugins/backend-plugins.js) - Frontend integration

## Notes

- **Directory naming**: Use underscores (e.g., `my_plugin`) not hyphens (e.g., `my-plugin`) in directory names to avoid Python import issues
- Shadow DOM: Frontend uses `querySelector` to access Shoelace menu elements
- Plugin discovery happens at startup
- Plugins can be reloaded without restart in dev mode
- Use `PluginManager.get_instance()` to access plugin manager
