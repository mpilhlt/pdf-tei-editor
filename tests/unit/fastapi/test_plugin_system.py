"""
Unit tests for the backend plugin system.

Tests plugin discovery, registration, validation, and execution.
"""

import unittest
import tempfile
import shutil
from pathlib import Path

from fastapi_app.lib.plugin_base import Plugin, PluginContext
from fastapi_app.lib.plugin_registry import PluginRegistry
from fastapi_app.lib.plugin_manager import PluginManager


class MockPlugin(Plugin):
    """Mock plugin for testing."""

    @property
    def metadata(self):
        return {
            "id": "mock-plugin",
            "name": "Mock Plugin",
            "description": "A test plugin",
            "version": "1.0.0",
            "category": "test",
            "required_roles": ["user"],
        }

    def get_endpoints(self):
        return {
            "execute": self.execute,
            "test": self.test_endpoint,
        }

    async def execute(self, context, params):
        return {"message": "executed", "params": params}

    async def test_endpoint(self, context, params):
        return {"test": True}


class AnotherMockPlugin(Plugin):
    """Another mock plugin for testing multiple plugins."""

    @property
    def metadata(self):
        return {
            "id": "another-mock",
            "name": "Another Mock",
            "description": "Another test plugin",
            "version": "1.0.0",
            "category": "analyzer",
            "required_roles": ["admin"],
        }

    def get_endpoints(self):
        return {
            "execute": self.execute,
        }

    async def execute(self, context, params):
        return {"result": "success"}


class TestPluginBase(unittest.TestCase):
    """Test Plugin base class."""

    def test_plugin_metadata_required(self):
        """Test that Plugin subclasses must implement metadata property."""
        with self.assertRaises(TypeError):
            # Cannot instantiate Plugin directly
            Plugin()

    def test_plugin_endpoints_required(self):
        """Test that Plugin subclasses must implement get_endpoints method."""
        # MockPlugin implements both, should work
        plugin = MockPlugin()
        self.assertIsNotNone(plugin.metadata)
        self.assertIsNotNone(plugin.get_endpoints())


class TestPluginRegistry(unittest.TestCase):
    """Test PluginRegistry functionality."""

    def setUp(self):
        """Set up test fixtures."""
        self.registry = PluginRegistry()
        self.temp_dir = Path(tempfile.mkdtemp())

    def tearDown(self):
        """Clean up test fixtures."""
        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir)

    def test_register_plugin(self):
        """Test registering a plugin instance."""
        plugin = MockPlugin()
        self.registry._register_plugin(plugin)

        self.assertEqual(len(self.registry._plugins), 1)
        self.assertIn("mock-plugin", self.registry._plugins)

    def test_register_duplicate_plugin_id(self):
        """Test that duplicate plugin IDs are rejected."""
        plugin1 = MockPlugin()
        plugin2 = MockPlugin()

        with self.assertLogs(level="WARNING") as logs:
            self.registry._register_plugin(plugin1)
            self.registry._register_plugin(plugin2)  # Should log warning

        # Should only have one plugin
        self.assertEqual(len(self.registry._plugins), 1)

    def test_get_plugin(self):
        """Test retrieving a plugin by ID."""
        plugin = MockPlugin()
        self.registry._register_plugin(plugin)

        retrieved = self.registry.get_plugin("mock-plugin")
        self.assertIsNotNone(retrieved)
        self.assertEqual(retrieved.metadata["id"], "mock-plugin")

    def test_get_nonexistent_plugin(self):
        """Test retrieving a plugin that doesn't exist."""
        result = self.registry.get_plugin("nonexistent")
        self.assertIsNone(result)

    def test_get_plugins_no_filter(self):
        """Test getting all plugins without filters."""
        plugin1 = MockPlugin()
        plugin2 = AnotherMockPlugin()

        self.registry._register_plugin(plugin1)
        self.registry._register_plugin(plugin2)

        plugins = self.registry.get_plugins()
        self.assertEqual(len(plugins), 2)

    def test_get_plugins_category_filter(self):
        """Test filtering plugins by category."""
        plugin1 = MockPlugin()
        plugin2 = AnotherMockPlugin()

        self.registry._register_plugin(plugin1)
        self.registry._register_plugin(plugin2)

        # Filter by 'test' category
        plugins = self.registry.get_plugins(category="test")
        self.assertEqual(len(plugins), 1)
        self.assertEqual(plugins[0]["id"], "mock-plugin")

        # Filter by 'analyzer' category
        plugins = self.registry.get_plugins(category="analyzer")
        self.assertEqual(len(plugins), 1)
        self.assertEqual(plugins[0]["id"], "another-mock")

    def test_get_plugins_role_filter(self):
        """Test filtering plugins by user roles."""
        plugin1 = MockPlugin()  # requires 'user' role
        plugin2 = AnotherMockPlugin()  # requires 'admin' role

        self.registry._register_plugin(plugin1)
        self.registry._register_plugin(plugin2)

        # User with 'user' role should see only plugin1
        plugins = self.registry.get_plugins(user_roles=["user"])
        self.assertEqual(len(plugins), 1)
        self.assertEqual(plugins[0]["id"], "mock-plugin")

        # User with 'admin' role should see only plugin2
        plugins = self.registry.get_plugins(user_roles=["admin"])
        self.assertEqual(len(plugins), 1)
        self.assertEqual(plugins[0]["id"], "another-mock")

        # User with both roles should see both plugins
        plugins = self.registry.get_plugins(user_roles=["user", "admin"])
        self.assertEqual(len(plugins), 2)

    def test_discover_plugins_empty_directory(self):
        """Test discovering plugins from empty directory."""
        self.registry.discover_plugins([self.temp_dir])
        self.assertEqual(len(self.registry._plugins), 0)

    def test_discover_plugins_nonexistent_directory(self):
        """Test discovering plugins from nonexistent directory."""
        nonexistent = self.temp_dir / "nonexistent"

        with self.assertLogs(level="WARNING") as logs:
            self.registry.discover_plugins([nonexistent])

        self.assertEqual(len(self.registry._plugins), 0)

    def test_discover_plugins_with_valid_plugin(self):
        """Test discovering a valid plugin from filesystem."""
        # Create plugin directory and file
        plugin_dir = self.temp_dir / "test-plugin"
        plugin_dir.mkdir()

        plugin_file = plugin_dir / "plugin.py"
        plugin_code = '''
from fastapi_app.lib.plugin_base import Plugin

class TestPlugin(Plugin):
    @property
    def metadata(self):
        return {
            "id": "test-plugin",
            "name": "Test Plugin",
            "description": "Test",
            "version": "1.0.0",
            "category": "test",
            "required_roles": []
        }

    def get_endpoints(self):
        return {"execute": lambda ctx, params: {"ok": True}}
'''
        plugin_file.write_text(plugin_code)

        # Discover plugins
        self.registry.discover_plugins([self.temp_dir])

        # Should have discovered one plugin
        self.assertEqual(len(self.registry._plugins), 1)
        self.assertIn("test-plugin", self.registry._plugins)


class TestPluginManager(unittest.IsolatedAsyncioTestCase):
    """Test PluginManager functionality."""

    def setUp(self):
        """Set up test fixtures."""
        # Reset singleton for each test
        PluginManager._instance = None
        self.manager = PluginManager.get_instance()
        self.temp_dir = Path(tempfile.mkdtemp())

    def tearDown(self):
        """Clean up test fixtures."""
        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir)
        PluginManager._instance = None

    def test_singleton_pattern(self):
        """Test that PluginManager is a singleton."""
        manager1 = PluginManager.get_instance()
        manager2 = PluginManager.get_instance()
        self.assertIs(manager1, manager2)

    def test_get_plugins(self):
        """Test getting plugins from manager."""
        plugin = MockPlugin()
        self.manager.registry._register_plugin(plugin)

        plugins = self.manager.get_plugins()
        self.assertEqual(len(plugins), 1)
        self.assertEqual(plugins[0]["id"], "mock-plugin")

    async def test_execute_plugin(self):
        """Test executing a plugin endpoint."""
        plugin = MockPlugin()
        self.manager.registry._register_plugin(plugin)

        result = await self.manager.execute_plugin(
            "mock-plugin", "execute", {"test": "data"}
        )

        self.assertEqual(result["message"], "executed")
        self.assertEqual(result["params"]["test"], "data")

    async def test_execute_nonexistent_plugin(self):
        """Test executing a plugin that doesn't exist."""
        with self.assertRaises(ValueError) as cm:
            await self.manager.execute_plugin("nonexistent", "execute", {})

        self.assertIn("Plugin not found", str(cm.exception))

    async def test_execute_nonexistent_endpoint(self):
        """Test executing an endpoint that doesn't exist."""
        plugin = MockPlugin()
        self.manager.registry._register_plugin(plugin)

        with self.assertRaises(ValueError) as cm:
            await self.manager.execute_plugin(
                "mock-plugin", "nonexistent", {}
            )

        self.assertIn("Endpoint not found", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
