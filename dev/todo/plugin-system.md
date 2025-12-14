# Backend Plugin System Implementation Plan

## Overview

Implement a bare-bones, extensible backend plugin system that:
- Auto-discovers plugins at runtime from filesystem
- Supports plugin categories and role-based access
- Allows plugins to define custom routes
- Provides frontend integration via toolbar dropdown
- Supports plugins outside main source code via environment variable

## Technical Requirements

### Plugin Discovery

**Plugin Location:**
- Primary: `fastapi_app/plugins/<plugin-id>/`
- Additional paths via environment variable: `FASTAPI_PLUGIN_PATHS` (colon-separated)
- Each plugin directory contains:
  - `plugin.py` - Plugin class definition (required)
  - `routes.py` - Custom FastAPI routes (optional)
  - Any other plugin-specific files

**Plugin Structure:**
```python
# fastapi_app/plugins/sample-analyzer/plugin.py
from fastapi_app.lib.plugin_base import Plugin

class SampleAnalyzerPlugin(Plugin):
    @property
    def metadata(self) -> dict:
        return {
            "id": "sample-analyzer",
            "name": "Sample Analyzer",
            "description": "A sample analysis plugin",
            "version": "1.0.0",
            "category": "analyzer",
            "required_roles": ["user"]  # or ["admin"], or [] for all
        }

    def get_endpoints(self) -> dict:
        return {
            "execute": self.execute
        }

    async def execute(self, context: dict) -> dict:
        # Plugin logic here
        return {"result": "analysis complete"}
```

**Route Registration (Optional):**
```python
# fastapi_app/plugins/sample-analyzer/routes.py
from fastapi import APIRouter

router = APIRouter(prefix="/api/plugins/sample-analyzer", tags=["sample-analyzer"])

@router.post("/custom-endpoint")
async def custom_endpoint(data: dict):
    return {"custom": "response"}
```

### Backend Components

**1. Plugin Base Class**
- File: `fastapi_app/lib/plugin_base.py`
- Abstract base class defining plugin interface
- Properties: `metadata`, `get_endpoints()`
- Optional lifecycle hooks: `initialize()`, `cleanup()`

**2. Plugin Registry**
- File: `fastapi_app/lib/plugin_registry.py`
- Discovers plugins from configured directories
- Loads plugin modules dynamically
- Validates plugin metadata
- Filters plugins by user roles
- Caches loaded plugins

**3. Plugin Manager**
- File: `fastapi_app/lib/plugin_manager.py`
- Singleton managing plugin lifecycle
- Registers custom routes from plugins
- Provides plugin lookup by ID/category
- Environment variable parsing for plugin paths

**4. API Endpoints**
- File: `fastapi_app/routes/plugins.py`
- `GET /api/plugins` - List available plugins (filtered by current user's roles)
  - Query param: `category` (optional filter)
  - Returns: `[{id, name, description, category}, ...]`
- `POST /api/plugins/{plugin_id}/execute` - Execute plugin endpoint
  - Body: `{endpoint: string, params: dict}`
  - Returns: Plugin-specific result

### Frontend Components

**1. Backend Plugins Frontend Plugin**
- File: `app/src/plugins/backend-plugins.js`
- Extends `Plugin` base class
- Discovers available backend plugins on startup
- Adds toolbar button if plugins are available
- Manages plugin execution UI

**2. UI Integration**
- Toolbar: Split button with dropdown (similar to delete button pattern)
- Button shown only if user has access to at least one plugin
- Dropdown sections organized by category
- On selection: Execute plugin via API call
- Show results in modal/notification

**3. API Client**
- Update `app/src/modules/api-client.js` or use existing patterns
- Methods:
  - `getPlugins(category?)` - Fetch available plugins
  - `executePlugin(pluginId, endpoint, params)` - Execute plugin

## Implementation Steps

### Phase 1: Backend Infrastructure

1. **Create plugin base class** (`fastapi_app/lib/plugin_base.py`)
   - Define `Plugin` ABC with `metadata` and `get_endpoints()`
   - Add optional `initialize()` and `cleanup()` hooks
   - Define `PluginContext` for dependency injection

2. **Create plugin registry** (`fastapi_app/lib/plugin_registry.py`)
   - Implement plugin discovery from directories
   - Dynamic module loading with error handling
   - Plugin validation (ensure required properties exist)
   - Role-based filtering

3. **Create plugin manager** (`fastapi_app/lib/plugin_manager.py`)
   - Singleton pattern for application-wide access
   - Parse `FASTAPI_PLUGIN_PATHS` environment variable
   - Register plugin routes with FastAPI app
   - Expose `get_plugins()` and `execute_plugin()` methods

4. **Integrate with FastAPI app** (`fastapi_app/main.py`)
   - Initialize plugin manager at startup
   - Register plugin routes
   - Add lifecycle event handlers (startup/shutdown)

5. **Create plugin API routes** (`fastapi_app/routes/plugins.py`)
   - `GET /api/plugins` with role filtering
   - `POST /api/plugins/{plugin_id}/execute`
   - Proper error handling and validation

### Phase 2: Sample Plugin

6. **Create sample plugin** (`fastapi_app/plugins/sample-analyzer/`)
   - `plugin.py` with basic analyzer implementation
   - `routes.py` with custom route example (optional)
   - Test data/fixtures if needed

7. **Write backend tests** (`tests/unit/fastapi/test_plugin_system.py`)
   - Test plugin discovery from multiple paths
   - Test role-based filtering
   - Test plugin execution
   - Test route registration
   - Test missing/invalid plugins

### Phase 3: Frontend Integration

8. **Create API client methods**
   - Add `getBackendPlugins(category)` to API client
   - Add `executeBackendPlugin(pluginId, endpoint, params)` to API client
   - Type definitions for plugin metadata

9. **Create backend-plugins frontend plugin** (`app/src/plugins/backend-plugins.js`)
   - Class extending `Plugin`
   - `install()`: Query available plugins
   - `start()`: Add toolbar button if plugins exist
   - `onStateUpdate()`: Show/hide based on login state
   - Handle plugin execution and result display

10. **Create UI template** (`app/src/templates/backend-plugins.html`)
    - Split button with dropdown
    - Category sections in dropdown
    - Loading states
    - Result modal/notification

11. **Register frontend plugin** (`app/src/app.js`)
    - Add `BackendPluginsPlugin` to plugins array
    - Ensure proper dependency order

### Phase 4: Testing

12. **Write API integration tests** (`tests/api/v1/plugins_list.test.js`)
    - Test plugin discovery endpoint
    - Test role-based access control
    - Test category filtering

13. **Write API integration tests** (`tests/api/v1/plugins_execute.test.js`)
    - Test plugin execution endpoint
    - Test error handling for missing plugins
    - Test parameter validation

14. **Manual E2E testing**
    - Login as different roles
    - Verify plugin button visibility
    - Execute sample plugin
    - Verify results display

### Phase 5: Documentation

15. **Create plugin development guide** (`docs/development/plugins.md`)
    - Plugin structure and conventions
    - Metadata schema
    - Route registration
    - Role-based access
    - Testing guidelines
    - Example plugin walkthrough

16. **Update architecture docs** (`docs/code-assistant/architecture.md`)
    - Add backend plugin system section
    - Explain plugin discovery mechanism
    - Document environment variables

## Key Design Decisions

### Plugin Discovery
- **Filesystem-based**: Simpler than database/config, easier for development
- **Runtime discovery**: Allows hot-reload in development, no rebuild needed
- **Environment variable**: Supports external plugins without modifying codebase

### Role-Based Access
- **Plugin-level**: Each plugin declares `required_roles` in metadata
- **Backend filtering**: Only return plugins user can access
- **Frontend hides button**: If no plugins available, don't clutter UI

### Route Registration
- **Optional routes.py**: Plugins can define custom routes beyond generic execute endpoint
- **Route override capability**: Plugins can override existing routes (use with caution)
- **Prefix convention**: Recommend `/api/plugins/{plugin-id}/` prefix

### Frontend Integration
- **Single toolbar button**: One entry point for all backend plugins
- **Category organization**: Dropdown sections prevent clutter as plugins grow
- **Conditional visibility**: Button only shown when plugins are available

### Extensibility Points
- Plugin base class can be extended with more lifecycle hooks
- Additional metadata fields can be added without breaking existing plugins
- Frontend can implement different UIs for different plugin categories
- Plugin manager can support dependency injection as needed

## Environment Variables

```bash
# Additional plugin paths (colon-separated on Unix, semicolon on Windows)
FASTAPI_PLUGIN_PATHS=/path/to/custom/plugins:/another/path
```

## File Structure

```
fastapi_app/
  lib/
    plugin_base.py           # Plugin ABC and PluginContext
    plugin_registry.py       # Plugin discovery and registration
    plugin_manager.py        # Plugin lifecycle management
  routes/
    plugins.py               # Plugin API endpoints
  plugins/
    sample-analyzer/
      plugin.py              # Sample plugin implementation
      routes.py              # Sample custom routes
  main.py                    # Initialize plugin manager

app/src/
  plugins/
    backend-plugins.js       # Frontend plugin for backend plugin integration
  templates/
    backend-plugins.html     # UI template for plugin dropdown

tests/
  unit/fastapi/
    test_plugin_system.py    # Unit tests for plugin system
  api/v1/
    plugins_list.test.js     # API test for plugin listing
    plugins_execute.test.js  # API test for plugin execution

docs/development/
  plugins.md                 # Plugin development guide
```

## API Schemas

### GET /api/plugins Response
```json
{
  "plugins": [
    {
      "id": "sample-analyzer",
      "name": "Sample Analyzer",
      "description": "A sample analysis plugin",
      "category": "analyzer",
      "version": "1.0.0"
    }
  ]
}
```

### POST /api/plugins/{plugin_id}/execute Request/Response
```json
// Request
{
  "endpoint": "execute",
  "params": {
    "file_id": "abc123",
    "options": {}
  }
}

// Response
{
  "success": true,
  "result": {
    // Plugin-specific result data
  }
}
```

## Testing Strategy

### Unit Tests (Python)
- Plugin discovery from multiple paths
- Role filtering logic
- Plugin validation
- Route registration
- Error handling

### API Integration Tests (JavaScript)
- Plugin listing with authentication
- Role-based access control
- Plugin execution
- Invalid plugin handling
- Parameter validation

### E2E Tests
- Full workflow: login → discover plugins → execute → view results
- Different user roles
- Multiple plugin categories

## Success Criteria

- [ ] Backend discovers plugins from filesystem
- [ ] Environment variable supports external plugin paths
- [ ] Role-based filtering works correctly
- [ ] Sample plugin executes successfully
- [ ] Frontend toolbar button appears for authorized users
- [ ] Plugin dropdown organizes by category
- [ ] Plugin execution returns results to frontend
- [ ] All tests pass
- [ ] Documentation complete

## Implementation Complete

**Summary:** Backend plugin system implemented with filesystem discovery, role-based access, category organization, and frontend toolbar integration.

**Key Lessons:**

1. **Shadow DOM Access:** Shoelace components use Shadow DOM - must use `querySelector` to access nested elements like menu items, not UI navigation hierarchy
2. **UI Updates:** Call `updateUi()` in `install()` but access UI elements only after all plugins installed (in `start()`)
3. **Menu Labels:** Use `<small>` element for category headers in Shoelace menus, not `<sl-menu-label>`
4. **Wildcard Roles:** Support `*` role in user roles list for unrestricted access
5. **Template Pattern:** Use `registerTemplate()` at module level, `createSingleFromTemplate()` + `insertBefore()` for positioning
6. **Typedef Required:** Always add UI typedefs for plugin elements even when Shadow DOM prevents navigation - enables autocomplete and documents structure

**Files Created:**
- Backend: [fastapi_app/lib/plugin_base.py](../../fastapi_app/lib/plugin_base.py), [plugin_registry.py](../../fastapi_app/lib/plugin_registry.py), [plugin_manager.py](../../fastapi_app/lib/plugin_manager.py)
- Routes: [fastapi_app/routes/plugins.py](../../fastapi_app/routes/plugins.py)
- Sample: [fastapi_app/plugins/sample-analyzer/](../../fastapi_app/plugins/sample-analyzer/)
- Frontend: [app/src/plugins/backend-plugins.js](../../app/src/plugins/backend-plugins.js), [app/src/templates/backend-plugins-button.html](../../app/src/templates/backend-plugins-button.html)
- Tests: [tests/unit/fastapi/test_plugin_system.py](../../tests/unit/fastapi/test_plugin_system.py)
- Docs: [docs/code-assistant/backend-plugins.md](../../docs/code-assistant/backend-plugins.md)

**Testing:** Backend unit tests passing. Manual E2E testing successful. API integration tests needed.

See [docs/code-assistant/backend-plugins.md](../../docs/code-assistant/backend-plugins.md) for usage guide.

## Future Enhancements (Out of Scope)

- Plugin dependency resolution
- Plugin versioning and compatibility checks
- Plugin hot-reload without server restart
- Plugin settings/configuration UI
- Plugin permissions beyond role-based (e.g., per-file)
- Plugin marketplace/registry
- Inter-plugin communication
- Plugin state persistence
