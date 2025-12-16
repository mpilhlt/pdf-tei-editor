"""
Unit tests for the backend plugin system.

Tests plugin discovery, registration, validation, and execution.
"""

import os
import unittest
import tempfile
import shutil
from pathlib import Path
from unittest.mock import patch

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


class MultiEndpointMockPlugin(Plugin):
    """Mock plugin with multiple endpoints for testing."""

    @property
    def metadata(self):
        return {
            "id": "multi-endpoint",
            "name": "Multi Endpoint Plugin",
            "description": "A plugin with multiple menu endpoints",
            "version": "1.0.0",
            "category": "test",
            "required_roles": ["user"],
            "endpoints": [
                {
                    "name": "analyze",
                    "label": "Analyze Document",
                    "description": "Analyze current document",
                    "state_params": ["xml", "variant"],
                },
                {
                    "name": "info",
                    "label": "Get Info",
                    "description": "Get plugin info",
                    "state_params": [],
                },
            ],
        }

    def get_endpoints(self):
        return {
            "analyze": self.analyze,
            "info": self.info,
        }

    async def analyze(self, context, params):
        return {"analyzed": True, "params": params}

    async def info(self, context, params):
        return {"info": "Multi-endpoint plugin"}


class ConditionallyAvailablePlugin(Plugin):
    """Mock plugin with conditional availability for testing."""

    @property
    def metadata(self):
        return {
            "id": "conditional-plugin",
            "name": "Conditional Plugin",
            "description": "A plugin with conditional availability",
            "version": "1.0.0",
            "category": "test",
            "required_roles": [],
        }

    def get_endpoints(self):
        return {
            "execute": self.execute,
        }

    @classmethod
    def is_available(cls) -> bool:
        """Only available in development or testing mode."""
        app_mode = os.environ.get("FASTAPI_APPLICATION_MODE", "development")
        return app_mode in ("development", "testing")

    async def execute(self, context, params):
        return {"available": True}


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

    def test_plugin_is_available_default(self):
        """Test that plugins are available by default."""
        self.assertTrue(MockPlugin.is_available())

    def test_plugin_conditional_availability(self):
        """Test plugin conditional availability based on environment."""
        # Should be available in development mode (default)
        with patch.dict(os.environ, {"FASTAPI_APPLICATION_MODE": "development"}):
            self.assertTrue(ConditionallyAvailablePlugin.is_available())

        # Should be available in testing mode
        with patch.dict(os.environ, {"FASTAPI_APPLICATION_MODE": "testing"}):
            self.assertTrue(ConditionallyAvailablePlugin.is_available())

        # Should not be available in production mode
        with patch.dict(os.environ, {"FASTAPI_APPLICATION_MODE": "production"}):
            self.assertFalse(ConditionallyAvailablePlugin.is_available())


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

    def test_discover_unavailable_plugin(self):
        """Test that unavailable plugins are not registered."""
        # Create plugin directory and file
        plugin_dir = self.temp_dir / "unavailable-plugin"
        plugin_dir.mkdir()

        plugin_file = plugin_dir / "plugin.py"
        plugin_code = '''
import os
from fastapi_app.lib.plugin_base import Plugin

class UnavailablePlugin(Plugin):
    @property
    def metadata(self):
        return {
            "id": "unavailable-plugin",
            "name": "Unavailable Plugin",
            "description": "Test unavailable plugin",
            "version": "1.0.0",
            "category": "test",
            "required_roles": []
        }

    def get_endpoints(self):
        return {"execute": lambda ctx, params: {"ok": True}}

    @classmethod
    def is_available(cls) -> bool:
        return os.environ.get("FASTAPI_APPLICATION_MODE") == "testing"
'''
        plugin_file.write_text(plugin_code)

        # Set mode to production (plugin should be unavailable)
        with patch.dict(os.environ, {"FASTAPI_APPLICATION_MODE": "production"}):
            with self.assertLogs(level="INFO") as logs:
                self.registry.discover_plugins([self.temp_dir])

            # Plugin should not be registered
            self.assertEqual(len(self.registry._plugins), 0)
            self.assertNotIn("unavailable-plugin", self.registry._plugins)

        # Reset registry
        self.registry = PluginRegistry()

        # Set mode to testing (plugin should be available)
        with patch.dict(os.environ, {"FASTAPI_APPLICATION_MODE": "testing"}):
            self.registry.discover_plugins([self.temp_dir])

            # Plugin should be registered
            self.assertEqual(len(self.registry._plugins), 1)
            self.assertIn("unavailable-plugin", self.registry._plugins)


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


class TestMultiEndpointPlugins(unittest.TestCase):
    """Test multi-endpoint plugin functionality."""

    def setUp(self):
        """Set up test fixtures."""
        self.registry = PluginRegistry()

    def test_plugin_with_endpoints_metadata(self):
        """Test that plugin endpoints metadata is preserved."""
        plugin = MultiEndpointMockPlugin()
        self.registry._register_plugin(plugin)

        plugins = self.registry.get_plugins()
        self.assertEqual(len(plugins), 1)

        plugin_metadata = plugins[0]
        self.assertIn("endpoints", plugin_metadata)
        self.assertEqual(len(plugin_metadata["endpoints"]), 2)

    def test_endpoint_metadata_structure(self):
        """Test that endpoint metadata has correct structure."""
        plugin = MultiEndpointMockPlugin()
        self.registry._register_plugin(plugin)

        plugins = self.registry.get_plugins()
        endpoint = plugins[0]["endpoints"][0]

        self.assertIn("name", endpoint)
        self.assertIn("label", endpoint)
        self.assertIn("description", endpoint)
        self.assertIn("state_params", endpoint)

    def test_state_params_in_endpoint(self):
        """Test that state_params are correctly included in endpoint metadata."""
        plugin = MultiEndpointMockPlugin()
        self.registry._register_plugin(plugin)

        plugins = self.registry.get_plugins()
        analyze_endpoint = plugins[0]["endpoints"][0]
        info_endpoint = plugins[0]["endpoints"][1]

        self.assertEqual(analyze_endpoint["state_params"], ["xml", "variant"])
        self.assertEqual(info_endpoint["state_params"], [])

    def test_backward_compatibility_no_endpoints(self):
        """Test that plugins without endpoints metadata still work."""
        plugin = MockPlugin()  # No endpoints in metadata
        self.registry._register_plugin(plugin)

        plugins = self.registry.get_plugins()
        self.assertEqual(len(plugins), 1)

        # Should not have endpoints field, or it should be None
        plugin_metadata = plugins[0]
        self.assertNotIn("endpoints", plugin_metadata)


class TestMultiEndpointExecution(unittest.IsolatedAsyncioTestCase):
    """Test executing multi-endpoint plugins."""

    def setUp(self):
        """Set up test fixtures."""
        PluginManager._instance = None
        self.manager = PluginManager.get_instance()

    def tearDown(self):
        """Clean up test fixtures."""
        PluginManager._instance = None

    async def test_execute_multi_endpoint_plugin(self):
        """Test executing different endpoints of a multi-endpoint plugin."""
        plugin = MultiEndpointMockPlugin()
        self.manager.registry._register_plugin(plugin)

        # Execute analyze endpoint
        result = await self.manager.execute_plugin(
            "multi-endpoint", "analyze", {"xml": "test.xml", "variant": "v1"}
        )
        self.assertTrue(result["analyzed"])
        self.assertEqual(result["params"]["xml"], "test.xml")
        self.assertEqual(result["params"]["variant"], "v1")

        # Execute info endpoint
        result = await self.manager.execute_plugin("multi-endpoint", "info", {})
        self.assertEqual(result["info"], "Multi-endpoint plugin")


if __name__ == "__main__":
    unittest.main()
