# Backend Plugin Development Guide

Practical guide for creating **backend plugins** in the PDF-TEI Editor.

**Note**: This guide covers **backend plugins** (Python code running on the server). For **frontend plugins** (JavaScript code running in the browser), see [plugin-development.md](./plugin-development.md). For detailed backend plugin architecture, see [../development/plugin-system-backend.md](../development/plugin-system-backend.md).

**Key Differences**:

- **Backend plugins**: Python modules in `fastapi_app/plugins/` that provide server-side functionality and API endpoints
- **Frontend plugins**: JavaScript classes in `app/src/plugins/` that extend the UI and handle client-side logic

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

```text
fastapi_app/plugins/my_plugin/
├── __init__.py
├── plugin.py          # Main plugin class
├── routes.py          # Optional custom routes
├── my-script.js       # Optional: frontend JavaScript
└── tests/             # Plugin tests
    ├── test_plugin.py # Python unit tests
    └── script.test.js # JavaScript unit tests (if applicable)
```

**Test Discovery**: The smart test runner automatically discovers tests in plugin `tests/` directories. Use `@testCovers` annotations to link tests to plugin files for dependency-based test execution.

**Example Test Annotation**:

```python
"""
Unit tests for My Plugin.

@testCovers fastapi_app/plugins/my_plugin/plugin.py
"""
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

## Service Registry

Plugins can register and consume services by capability name without hard dependencies. See [Service Registry](../development/service-registry.md) for details.

## Plugin Dependencies

Plugins can declare dependencies on other plugins. The plugin system loads dependencies first and provides runtime access to them.

### Declaring Dependencies

Add a `dependencies` field to your plugin metadata:

```python
@property
def metadata(self) -> dict[str, Any]:
    return {
        "id": "my-plugin",
        "name": "My Plugin",
        "description": "Plugin that uses another plugin",
        "category": "analyzer",
        "version": "1.0.0",
        "required_roles": ["user"],
        "dependencies": ["base-analyzer", "data-exporter"],
    }
```

### Accessing Dependencies

Use `context.get_dependency()` in your endpoint methods:

```python
async def execute(self, context, params: dict) -> dict:
    # Get dependency plugin instance
    analyzer = context.get_dependency("base-analyzer")
    if analyzer:
        # Call dependency endpoint
        result = await analyzer.get_endpoints()["analyze"](context, params)
        return {"analysis": result}
    return {"error": "Dependency not available"}
```

### Behavior

- Plugins are loaded in dependency order (dependencies first)
- Missing dependencies prevent plugin registration
- Circular dependencies are detected and reported
- Undeclared dependency access logs a warning and returns None

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

## Plugin Configuration with Environment Variables

Plugins often need configuration that can be set via environment variables or config keys.

### Initialization Pattern

**Initialize configuration values at plugin registration time** in `__init__.py`. This ensures config keys are created from environment variables when the plugin is loaded:

```python
# __init__.py
from fastapi_app.lib.plugin_tools import get_plugin_config

# Initialize config values from environment variables
get_plugin_config("plugin.my-plugin.enabled", "MY_PLUGIN_ENABLED", default=False, value_type="boolean")
get_plugin_config("plugin.my-plugin.api-key", "MY_PLUGIN_API_KEY", default=None)
get_plugin_config("plugin.my-plugin.timeout", "MY_PLUGIN_TIMEOUT", default=30, value_type="number")

from .plugin import MyPlugin

plugin = MyPlugin()
```

**Access configuration in plugin methods** using `get_config()`:

```python
# plugin.py
from fastapi_app.lib.config_utils import get_config

class MyPlugin(Plugin):
    async def execute(self, context, params: dict) -> dict:
        config = get_config()
        api_key = config.get("plugin.my-plugin.api-key")
        timeout = config.get("plugin.my-plugin.timeout", default=30)

        # Use config values...
```

**Access configuration in custom routes** using `get_config()`:

```python
# routes.py
from fastapi_app.lib.config_utils import get_config

@router.get("/action")
async def custom_action():
    config = get_config()
    api_key = config.get("plugin.my-plugin.api-key")

    # Use config values...
```

**Priority**: Config file (`data/db/config.json`) > Environment variable > Default value

**Key points**:

- Initialize config in `__init__.py` using `get_plugin_config()` (creates keys from env vars)
- Access config everywhere else using `get_config()` (retrieves existing keys)
- Config values are automatically created from environment variables on first initialization
- Routes and plugin methods use the same `get_config()` pattern

**Example - Plugin availability based on config**:

```python
@classmethod
def is_available(cls) -> bool:
    """Only available if enabled in config."""
    from fastapi_app.lib.plugin_tools import get_plugin_config

    enabled = get_plugin_config(
        "plugin.my-plugin.enabled",
        "MY_PLUGIN_ENABLED",
        default=False,
        value_type="boolean"
    )

    if not enabled:
        return False

    # Check if required configuration is present
    api_key = get_plugin_config(
        "plugin.my-plugin.api-key",
        "MY_PLUGIN_API_KEY",
        default=None
    )

    if not api_key:
        return False

    return True
```

**Reference Implementation**: See [local_sync plugin](../../fastapi_app/plugins/local_sync) for complete example.

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

**Automatic Route Discovery:**

Routes are automatically discovered and registered by the `PluginManager` at application startup. The discovery process:

1. Searches for `routes.py` in each plugin directory
2. Loads the module using `importlib`
3. Looks for a `router` object in the module
4. Registers the router with the FastAPI app via `app.include_router()`

**No manual registration is required** - simply create a `routes.py` file with a `router` export and it will be automatically discovered. The router is registered at the application level (not under `api_v1`), so routes are unversioned.

**Export in `__init__.py` (recommended):**

For consistency with other plugins, also export the router in `__init__.py`:

```python
# __init__.py
from .plugin import MyPlugin
from .routes import router

__all__ = ["MyPlugin", "router"]
```

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

## Plugin Response Formats

Backend plugins can return results in three formats depending on the complexity and interaction requirements:

### 1. Inline HTML (for simple content)

Use the `html` field for short, simple text results that fit comfortably in the dialog:

```python
async def execute(self, context, params: dict) -> dict:
    """Return simple HTML content."""
    return {
        "html": "<p>Analysis complete. Found 42 matches.</p>"
    }
```

**When to use:**
- Short text results (a few paragraphs)
- Simple lists or small tables
- Quick status messages or summaries
- Content that doesn't need extensive formatting

### 2. Standalone Pages (for complex content)

Use the `outputUrl` field for complex, tabular data, or content requiring JavaScript libraries:

```python
async def execute(self, context, params: dict) -> dict:
    """Return URL to standalone page."""
    collection_id = params.get("collection")
    variant = params.get("variant")

    # Build URL to custom route that returns complete HTML page
    view_url = f"/api/plugins/my-plugin/view?collection={collection_id}&variant={variant}"
    export_url = f"/api/plugins/my-plugin/export?collection={collection_id}&variant={variant}"

    return {
        "outputUrl": view_url,      # Displayed in iframe
        "exportUrl": export_url,    # Optional: enable export button
        "collection": collection_id # Optional: pass data to frontend
    }
```

**When to use:**
- Large tables with sorting/filtering (e.g., DataTables)
- Content requiring external JavaScript libraries
- Complex visualizations or charts
- Multi-section reports
- Any content needing custom CSS or extensive styling

**Benefits:**
- Proper script execution (iframe loads scripts naturally)
- Better performance (libraries load once)
- "Open in new window" button for full-screen viewing
- Cleaner separation (route generates HTML, plugin coordinates)

**Implementation pattern:**

1. **Create a custom route** in `routes.py` that generates the full HTML page:

```python
from fastapi import APIRouter
from fastapi.responses import HTMLResponse
from fastapi_app.lib.plugin_tools import generate_datatable_page, escape_html

router = APIRouter(prefix="/api/plugins/my-plugin", tags=["my-plugin"])

@router.get("/view", response_class=HTMLResponse)
async def view_results(
    collection: str = Query(...),
    variant: str | None = Query(None),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """Generate standalone HTML page with results."""
    # Authenticate user (see User Authentication section)
    # ...

    # Prepare table data
    headers = ["Column 1", "Column 2", "Column 3"]
    rows = [
        [escape_html("Data 1"), escape_html("Data 2"), "Data 3"],
        # ... more rows
    ]

    # Generate HTML page with DataTables
    html = generate_datatable_page(
        title="My Plugin Results",
        headers=headers,
        rows=rows,
        table_id="resultsTable",
        page_length=25,
        default_sort_col=0,
        default_sort_dir="desc",
        enable_sandbox_client=True  # For inter-window communication
    )

    return HTMLResponse(content=html)
```

2. **Return the URL** from your plugin endpoint:

```python
async def execute(self, context, params: dict) -> dict:
    collection_id = params.get("collection")
    view_url = f"/api/plugins/my-plugin/view?collection={collection_id}"

    return {
        "outputUrl": view_url,
        "collection": collection_id
    }
```

**See also:** [edit_history plugin](../../fastapi_app/plugins/edit_history) for complete example.

### 3. Preview-then-Execute Pattern (for operations requiring confirmation)

Use the `outputUrl` and `executeUrl` fields together for operations that should show a preview before execution:

```python
async def execute(self, context, params: dict) -> dict:
    """Return URLs for preview and execute endpoints."""
    collection_id = params.get("collection")
    variant = params.get("variant", "all")

    # Build URLs for preview and execute
    variant_param = f"&variant={variant}" if variant != "all" else ""
    preview_url = f"/api/plugins/my-plugin/preview?collection={collection_id}{variant_param}"
    execute_url = f"/api/plugins/my-plugin/execute?collection={collection_id}{variant_param}"

    return {
        "outputUrl": preview_url,      # Shows preview in iframe
        "executeUrl": execute_url,      # Execute button calls this URL
        "collection": collection_id,
        "variant": variant
    }
```

**When to use:**

- Operations that modify data (syncing, batch updates, deletions)
- Operations where users need to review changes before applying
- Operations that can be expensive and should be confirmed

**User flow:**

1. Plugin returns `outputUrl` and `executeUrl`
2. Frontend displays preview in iframe (from `outputUrl`)
3. Execute button appears in dialog footer
4. User reviews changes and clicks Execute
5. Execute button loads `executeUrl` in the same iframe
6. Execute button is hidden after clicking

**Implementation pattern:**

Create two routes in `routes.py`:

```python
@router.get("/preview", response_class=HTMLResponse)
async def preview_operation(
    collection: str = Query(...),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """Generate preview HTML (dry-run mode)."""
    # Authenticate user
    # Perform dry-run operation
    # Generate detailed HTML with preview notice
    # Return HTML with message: "Click Execute to apply these changes"
    return HTMLResponse(content=preview_html)

@router.get("/execute", response_class=HTMLResponse)
async def execute_operation(
    collection: str = Query(...),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """Execute the operation and return summary HTML."""
    # Authenticate user
    # Perform actual operation
    # Generate summary HTML (statistics only)
    return HTMLResponse(content=summary_html)
```

**Preview HTML structure:**

- Include prominent notice: "Preview Mode - Click Execute to apply changes"
- Show detailed list of changes that will be made
- Use complete HTML document with styles
- Keep layout clean and readable

**Execute HTML structure:**

- Show success message
- Display summary statistics only (no details)
- Optionally show errors if any occurred
- Use complete HTML document with styles

**See also:** [local_sync plugin](../../fastapi_app/plugins/local_sync) for complete example.

## Interactive HTML Content

Both response formats support interactive elements through the **Plugin Sandbox** interface.

### Plugin Sandbox API

When plugin content is displayed (either via `html` or `outputUrl`), a `window.pluginSandbox` object (or `window.sandbox` in standalone pages) exposes methods to interact with the application:

```javascript
// Available methods:
// - In inline HTML: window.pluginSandbox
// - In standalone pages (outputUrl): window.sandbox

// Update application state (any fields from ApplicationState) - async
await pluginSandbox.updateState({ xml: 'doc-id', variant: 'model-x' });

// Close the result dialog
pluginSandbox.closeDialog();

// Convenience: Open a document (updates xml state, clears diff, closes dialog) - async
await pluginSandbox.openDocument('stable-id');

// Convenience: Open diff view (updates xml and diff states, closes dialog) - async
await pluginSandbox.openDiff('stable-id-1', 'stable-id-2');
```

### Example: Clickable Links

**In inline HTML:**

```python
async def execute(self, context, params: dict) -> dict:
    """Generate interactive HTML with clickable links."""
    doc_id = "abc123"

    # Create clickable link that opens document
    html = f'''
    <p>View document:
      <a href="#"
         onclick="window.pluginSandbox.openDocument('{doc_id}'); return false;"
         style="color: #0066cc; text-decoration: underline;">
        {doc_id}
      </a>
    </p>
    '''

    return {"html": html}
```

**In standalone pages (outputUrl):**

When using `generate_datatable_page()` with `enable_sandbox_client=True`, use `sandbox` (not `pluginSandbox`):

```python
# In your custom route
from fastapi_app.lib.plugin_tools import escape_html

doc_link = f'''<a href="#"
   onclick="sandbox.openDocument('{entry["stable_id"]}'); return false;"
   style="color: #0066cc; text-decoration: underline;">
   {escape_html(entry["doc_label"])}
</a>'''

rows.append([
    escape_html(entry["date"]),
    doc_link,  # Clickable link
    escape_html(entry["description"])
])
```

### Available State Fields

The sandbox can update any field from `ApplicationState` (see [app/src/state.js](../../app/src/state.js)):

- `xml` - Open XML document ID
- `diff` - Diff XML document ID (triggers diff view when set with `xml`)
- `pdf` - Open PDF document ID
- `xpath` - Current XPath selection
- `variant` - Variant filter
- `collection` - Current collection ID
- Other fields as needed

### Implementation Examples

- **Inline HTML**: The [iaa_analyzer plugin](../../fastapi_app/plugins/iaa_analyzer/plugin.py) demonstrates inline HTML with clickable stable IDs and match counts that open documents or diff views
- **Standalone pages**: The [edit_history plugin](../../fastapi_app/plugins/edit_history) demonstrates the `outputUrl` pattern with a complete DataTables implementation

### Utility Functions

The `fastapi_app.lib.plugin_tools` module provides utilities for generating plugin content:

**`generate_datatable_page()`** - Generate complete HTML page with sortable DataTables table:

```python
from fastapi_app.lib.plugin_tools import generate_datatable_page, escape_html

html = generate_datatable_page(
    title="Results",                    # Page title
    headers=["Col1", "Col2"],          # Column headers
    rows=[                              # Table rows (can contain HTML)
        [escape_html("A"), "B"],
        [escape_html("C"), "D"]
    ],
    table_id="myTable",                # HTML table ID
    page_length=25,                    # Rows per page
    default_sort_col=0,                # Sort column index
    default_sort_dir="desc",           # "asc" or "desc"
    enable_sandbox_client=True,        # Include sandbox for links
    custom_css="",                     # Additional CSS
    custom_js=""                       # Additional JavaScript
)
```

**`escape_html()`** - Escape HTML to prevent XSS:

```python
from fastapi_app.lib.plugin_tools import escape_html

safe_text = escape_html(user_input)  # Escapes <, >, &, ", '
```

**`generate_sandbox_client_script()`** - Generate sandbox client for custom HTML pages (advanced use).

## Frontend Extensions

Backend plugins can register JavaScript files that extend frontend functionality. These extensions integrate with the application's PluginManager lifecycle and have access to a controlled sandbox API.

See [Frontend Extensions](../development/frontend-extensions.md) for detailed documentation.

Quick reference:

- Register extensions via `FrontendExtensionRegistry.register_extension(path, plugin_id)`
- Extensions integrate with PluginManager lifecycle (`install`, `start`, `onStateUpdate`)
- Use sandbox for controlled API access (`ui`, `dialog`, `notify`, `invoke`, etc.)

**Example registration in plugin initialize():**

```python
from fastapi_app.lib.frontend_extension_registry import FrontendExtensionRegistry
from pathlib import Path

async def initialize(self, context: PluginContext) -> None:
    registry = FrontendExtensionRegistry.get_instance()
    extension_file = Path(__file__).parent / "extensions" / "my-extension.js"
    if extension_file.exists():
        registry.register_extension(extension_file, self.metadata["id"])
```

## Notes

- **Directory naming**: Use underscores (e.g., `my_plugin`) not hyphens (e.g., `my-plugin`) in directory names to avoid Python import issues
- Shadow DOM: Frontend uses `querySelector` to access Shoelace menu elements
- Plugin discovery happens at startup
- Plugins can be reloaded without restart in dev mode
- Use `PluginManager.get_instance()` to access plugin manager
- **Plugin Sandbox**: Always available as `window.pluginSandbox` when plugin HTML is displayed
- **HTML escaping**: Always escape user-provided content in HTML to prevent XSS attacks
