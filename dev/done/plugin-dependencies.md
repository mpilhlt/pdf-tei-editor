# Plugin Dependency Management Implementation

GitHub Issue: <https://github.com/mpilhlt/pdf-tei-editor/issues/231>

## Overview

Add dependency declaration and enforcement to backend plugins. Plugins can declare other plugins they require, and the registration system validates these dependencies during discovery.

## Current Architecture

Plugin loading flow:

1. `PluginManager.discover_plugins()` iterates plugin directories
2. `PluginRegistry.discover_plugins()` loads each `plugin.py`
3. `PluginRegistry._load_plugin()` checks `is_available()`, instantiates the plugin
4. `PluginRegistry._register_plugin()` validates metadata and registers

Key files:

- [fastapi_app/lib/plugin_base.py](../../fastapi_app/lib/plugin_base.py) - `Plugin` base class
- [fastapi_app/lib/plugin_registry.py](../../fastapi_app/lib/plugin_registry.py) - Discovery and registration
- [fastapi_app/lib/plugin_manager.py](../../fastapi_app/lib/plugin_manager.py) - Lifecycle management

## Implementation

### 1. Extend Plugin Metadata

Add optional `dependencies` field to metadata in `plugin_base.py`:

```python
@property
@abstractmethod
def metadata(self) -> dict[str, Any]:
    """
    Return plugin metadata.

    Required fields:
        - id (str): Unique plugin identifier
        - name (str): Human-readable plugin name
        - description (str): Brief description
        - category (str): Plugin category
        - version (str): Plugin version
        - required_roles (list[str]): Roles required to access plugin

    Optional fields:
        - dependencies (list[str]): Plugin IDs this plugin depends on
        - endpoints (list[dict]): Menu endpoint definitions
    """
```

### 2. Two-Phase Registration

Modify `PluginRegistry` to use two-phase registration:

**Phase 1: Load all plugins**

```python
def discover_plugins(self, plugin_dirs: list[Path]) -> None:
    # First pass: load all plugins
    pending_plugins: list[Plugin] = []

    for plugin_dir in plugin_dirs:
        # ... existing directory iteration ...
        plugin = self._load_plugin(plugin_path, plugin_file)
        if plugin:
            pending_plugins.append(plugin)

    # Second pass: register with dependency resolution
    self._register_with_dependencies(pending_plugins)
```

**Phase 2: Topological sort and register**

```python
def _register_with_dependencies(self, plugins: list[Plugin]) -> None:
    """Register plugins in dependency order."""
    # Build dependency graph
    plugin_map = {p.metadata["id"]: p for p in plugins}

    # Topological sort
    registered = set()

    def register_plugin(plugin_id: str, path: list[str]) -> bool:
        if plugin_id in registered:
            return True
        if plugin_id in path:
            cycle = " -> ".join(path + [plugin_id])
            logger.error(f"Circular dependency detected: {cycle}")
            return False
        if plugin_id not in plugin_map:
            logger.error(f"Missing dependency: {plugin_id}")
            return False

        plugin = plugin_map[plugin_id]
        deps = plugin.metadata.get("dependencies", [])

        for dep_id in deps:
            if not register_plugin(dep_id, path + [plugin_id]):
                return False

        self._register_plugin(plugin)
        registered.add(plugin_id)
        return True

    for plugin_id in plugin_map:
        register_plugin(plugin_id, [])
```

### 3. Runtime Access to Dependencies

Add method to `PluginRegistry` for plugins to access dependencies:

```python
def get_dependency(self, plugin_id: str, dependency_id: str) -> Plugin | None:
    """
    Get a dependency plugin instance.

    Args:
        plugin_id: ID of the requesting plugin
        dependency_id: ID of the dependency to retrieve

    Returns:
        Plugin instance or None if not a declared dependency
    """
    plugin = self._plugins.get(plugin_id)
    if not plugin:
        return None

    deps = plugin.metadata.get("dependencies", [])
    if dependency_id not in deps:
        logger.warning(
            f"Plugin {plugin_id} requested undeclared dependency {dependency_id}"
        )
        return None

    return self._plugins.get(dependency_id)
```

### 4. PluginContext Enhancement

Add dependency access to `PluginContext` in `plugin_base.py`:

```python
class PluginContext:
    def __init__(
        self,
        app: Any = None,
        user: dict | None = None,
        plugin_id: str | None = None,
        registry: Any = None
    ):
        self._app = app
        self._user = user
        self._plugin_id = plugin_id
        self._registry = registry

    def get_dependency(self, dependency_id: str) -> "Plugin | None":
        """Get a declared dependency plugin."""
        if not self._registry or not self._plugin_id:
            return None
        return self._registry.get_dependency(self._plugin_id, dependency_id)
```

Update `PluginManager.execute_plugin()` to pass plugin_id and registry to context.

### 5. Update Documentation

Add to [docs/code-assistant/backend-plugins.md](../../docs/code-assistant/backend-plugins.md):

```markdown
## Plugin Dependencies

Plugins can declare dependencies on other plugins:

### Declaring Dependencies

```python
@property
def metadata(self) -> dict[str, Any]:
    return {
        "id": "my-plugin",
        "name": "My Plugin",
        "dependencies": ["base-analyzer", "data-exporter"],
        # ... other fields
    }
```

### Accessing Dependencies

```python
async def execute(self, context, params: dict) -> dict:
    # Get dependency plugin instance
    analyzer = context.get_dependency("base-analyzer")
    if analyzer:
        # Call dependency endpoint
        result = await analyzer.get_endpoints()["analyze"](context, params)
```

### Behavior

- Plugins are loaded in dependency order
- Missing dependencies prevent plugin registration
- Circular dependencies are detected and reported
- Undeclared dependency access logs a warning

```

## Testing

Create test file `fastapi_app/lib/tests/test_plugin_dependencies.py`:

```python
"""
Tests for plugin dependency management.

@testCovers fastapi_app/lib/plugin_registry.py
"""

import unittest
from fastapi_app.lib.plugin_base import Plugin
from fastapi_app.lib.plugin_registry import PluginRegistry


class MockPlugin(Plugin):
    def __init__(self, plugin_id: str, deps: list[str] = None):
        self._id = plugin_id
        self._deps = deps or []

    @property
    def metadata(self):
        return {
            "id": self._id,
            "name": f"Mock {self._id}",
            "description": "Test plugin",
            "category": "test",
            "version": "1.0.0",
            "required_roles": ["*"],
            "dependencies": self._deps
        }

    def get_endpoints(self):
        return {}


class TestPluginDependencies(unittest.TestCase):
    def test_dependency_order(self):
        """Plugins register after their dependencies."""
        registry = PluginRegistry()

        plugins = [
            MockPlugin("child", ["parent"]),
            MockPlugin("parent", []),
        ]

        registry._register_with_dependencies(plugins)

        # Parent should be registered before child
        plugin_ids = list(registry._plugins.keys())
        self.assertEqual(plugin_ids, ["parent", "child"])

    def test_circular_dependency_detection(self):
        """Circular dependencies are detected."""
        registry = PluginRegistry()

        plugins = [
            MockPlugin("a", ["b"]),
            MockPlugin("b", ["a"]),
        ]

        registry._register_with_dependencies(plugins)

        # Neither should be registered
        self.assertEqual(len(registry._plugins), 0)

    def test_missing_dependency(self):
        """Missing dependencies prevent registration."""
        registry = PluginRegistry()

        plugins = [MockPlugin("child", ["nonexistent"])]

        registry._register_with_dependencies(plugins)

        self.assertEqual(len(registry._plugins), 0)
```

## Implementation Order

1. Update `plugin_base.py` - add `dependencies` to metadata docstring, update `PluginContext`
2. Update `plugin_registry.py` - implement two-phase registration, add `get_dependency()`
3. Update `plugin_manager.py` - pass plugin_id and registry to context
4. Add tests in `tests/unit/fastapi/test_plugin_dependencies.py`
5. Update documentation in `docs/code-assistant/backend-plugins.md`

## Implementation Summary

Implemented plugin dependency management with the following changes:

### Files Modified

- [fastapi_app/lib/plugin_base.py](../../fastapi_app/lib/plugin_base.py):
  - Added `plugin_id` and `registry` parameters to `PluginContext.__init__()`
  - Added `get_dependency()` method to `PluginContext`
  - Updated metadata docstring to document the `dependencies` field

- [fastapi_app/lib/plugin_registry.py](../../fastapi_app/lib/plugin_registry.py):
  - Modified `discover_plugins()` to use two-phase registration
  - Added `_register_with_dependencies()` for topological sort and registration
  - Added `get_dependency()` method for retrieving declared dependencies

- [fastapi_app/lib/plugin_manager.py](../../fastapi_app/lib/plugin_manager.py):
  - Updated `execute_plugin()` to pass `plugin_id` and `registry` to `PluginContext`

- [docs/code-assistant/backend-plugins.md](../../docs/code-assistant/backend-plugins.md):
  - Added "Plugin Dependencies" section with usage examples

### Files Created

- [tests/unit/fastapi/test_plugin_dependencies.py](../../tests/unit/fastapi/test_plugin_dependencies.py):
  - 16 tests covering dependency ordering, circular detection, missing dependencies, and runtime access
