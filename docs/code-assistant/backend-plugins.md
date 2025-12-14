# Backend Plugin System

Technical guide for creating backend plugins in the PDF-TEI Editor.

## Architecture

Backend plugins are Python modules discovered at runtime from:
- `fastapi_app/plugins/<plugin-id>/`
- Paths in `FASTAPI_PLUGIN_PATHS` environment variable (colon-separated)

Each plugin:
- Inherits from `fastapi_app.lib.plugin_base.Plugin`
- Defines metadata (id, name, description, category, version, required_roles)
- Implements endpoints as async methods
- Has access to `PluginContext` for app state and user info

## Creating a Plugin

### Directory Structure

```
fastapi_app/plugins/my-plugin/
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

Add `routes.py` for custom FastAPI routes:

```python
from fastapi import APIRouter

router = APIRouter()

@router.get("/custom")
async def custom_route():
    return {"custom": "data"}
```

Routes are auto-registered under `/api/v1/plugins/{plugin_id}/`.

## Key Files

- [fastapi_app/lib/plugin_base.py](../../fastapi_app/lib/plugin_base.py) - Base classes
- [fastapi_app/lib/plugin_registry.py](../../fastapi_app/lib/plugin_registry.py) - Discovery
- [fastapi_app/lib/plugin_manager.py](../../fastapi_app/lib/plugin_manager.py) - Lifecycle
- [fastapi_app/routes/plugins.py](../../fastapi_app/routes/plugins.py) - API routes
- [app/src/plugins/backend-plugins.js](../../app/src/plugins/backend-plugins.js) - Frontend integration

## Notes

- Shadow DOM: Frontend uses `querySelector` to access Shoelace menu elements
- Plugin discovery happens at startup
- Plugins can be reloaded without restart in dev mode
- Use `PluginManager.get_instance()` to access plugin manager
