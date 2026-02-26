"""
Tests for plugin dependency management.

@testCovers fastapi_app/lib/plugins/plugin_registry.py
@testCovers fastapi_app/lib/plugins/plugin_base.py
"""

import unittest

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.plugins.plugin_registry import PluginRegistry
from fastapi_app.lib.plugins.plugin_manager import PluginManager


class MockPlugin(Plugin):
    """Mock plugin for dependency testing."""

    def __init__(self, plugin_id: str, deps: list[str] | None = None):
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
            "dependencies": self._deps,
        }

    def get_endpoints(self):
        return {"execute": self.execute}

    async def execute(self, context, params):
        return {"id": self._id}


class TestPluginDependencyOrder(unittest.TestCase):
    """Test that plugins are registered in dependency order."""

    def setUp(self):
        self.registry = PluginRegistry()

    def test_dependency_order_simple(self):
        """Plugins register after their dependencies."""
        plugins = [
            MockPlugin("child", ["parent"]),
            MockPlugin("parent", []),
        ]

        self.registry._register_with_dependencies(plugins)

        # Both should be registered
        self.assertEqual(len(self.registry._plugins), 2)

        # Parent should be registered before child
        plugin_ids = list(self.registry._plugins.keys())
        self.assertEqual(plugin_ids.index("parent"), 0)
        self.assertEqual(plugin_ids.index("child"), 1)

    def test_dependency_order_chain(self):
        """Test a chain of dependencies: a -> b -> c."""
        plugins = [
            MockPlugin("a", ["b"]),
            MockPlugin("b", ["c"]),
            MockPlugin("c", []),
        ]

        self.registry._register_with_dependencies(plugins)

        plugin_ids = list(self.registry._plugins.keys())
        self.assertEqual(plugin_ids, ["c", "b", "a"])

    def test_dependency_order_multiple(self):
        """Test plugin with multiple dependencies."""
        plugins = [
            MockPlugin("child", ["parent1", "parent2"]),
            MockPlugin("parent1", []),
            MockPlugin("parent2", []),
        ]

        self.registry._register_with_dependencies(plugins)

        # All should be registered
        self.assertEqual(len(self.registry._plugins), 3)

        # Child should be last
        plugin_ids = list(self.registry._plugins.keys())
        self.assertEqual(plugin_ids[-1], "child")

    def test_no_dependencies(self):
        """Plugins without dependencies register normally."""
        plugins = [
            MockPlugin("a", []),
            MockPlugin("b", []),
            MockPlugin("c", []),
        ]

        self.registry._register_with_dependencies(plugins)

        self.assertEqual(len(self.registry._plugins), 3)


class TestCircularDependencyDetection(unittest.TestCase):
    """Test circular dependency detection."""

    def setUp(self):
        self.registry = PluginRegistry()

    def test_circular_dependency_two_plugins(self):
        """Circular dependencies between two plugins are detected."""
        plugins = [
            MockPlugin("a", ["b"]),
            MockPlugin("b", ["a"]),
        ]

        with self.assertLogs("fastapi_app.lib.plugins.plugin_registry", level="ERROR") as logs:
            self.registry._register_with_dependencies(plugins)

        # Neither should be registered
        self.assertEqual(len(self.registry._plugins), 0)

        # Should log circular dependency error
        self.assertTrue(
            any("Circular dependency" in log for log in logs.output)
        )

    def test_circular_dependency_three_plugins(self):
        """Circular dependencies in a chain are detected."""
        plugins = [
            MockPlugin("a", ["b"]),
            MockPlugin("b", ["c"]),
            MockPlugin("c", ["a"]),
        ]

        with self.assertLogs("fastapi_app.lib.plugins.plugin_registry", level="ERROR") as logs:
            self.registry._register_with_dependencies(plugins)

        # None should be registered due to cycle
        self.assertEqual(len(self.registry._plugins), 0)

    def test_self_dependency(self):
        """Self-dependency is detected as circular."""
        plugins = [MockPlugin("a", ["a"])]

        with self.assertLogs("fastapi_app.lib.plugins.plugin_registry", level="ERROR") as logs:
            self.registry._register_with_dependencies(plugins)

        self.assertEqual(len(self.registry._plugins), 0)


class TestMissingDependency(unittest.TestCase):
    """Test missing dependency handling."""

    def setUp(self):
        self.registry = PluginRegistry()

    def test_missing_dependency(self):
        """Missing dependencies prevent registration."""
        plugins = [MockPlugin("child", ["nonexistent"])]

        with self.assertLogs("fastapi_app.lib.plugins.plugin_registry", level="ERROR") as logs:
            self.registry._register_with_dependencies(plugins)

        self.assertEqual(len(self.registry._plugins), 0)
        self.assertTrue(
            any("Missing dependency" in log for log in logs.output)
        )

    def test_partial_missing_dependency(self):
        """Plugin with one missing dependency doesn't register, others do."""
        plugins = [
            MockPlugin("good", []),
            MockPlugin("bad", ["nonexistent"]),
        ]

        with self.assertLogs("fastapi_app.lib.plugins.plugin_registry", level="ERROR") as logs:
            self.registry._register_with_dependencies(plugins)

        # Only 'good' should be registered
        self.assertEqual(len(self.registry._plugins), 1)
        self.assertIn("good", self.registry._plugins)
        self.assertNotIn("bad", self.registry._plugins)


class TestGetDependency(unittest.TestCase):
    """Test get_dependency method."""

    def setUp(self):
        self.registry = PluginRegistry()

    def test_get_declared_dependency(self):
        """Can retrieve a declared dependency."""
        plugins = [
            MockPlugin("child", ["parent"]),
            MockPlugin("parent", []),
        ]
        self.registry._register_with_dependencies(plugins)

        dependency = self.registry.get_dependency("child", "parent")
        self.assertIsNotNone(dependency)
        self.assertEqual(dependency.metadata["id"], "parent")

    def test_get_undeclared_dependency_logs_warning(self):
        """Requesting undeclared dependency logs a warning."""
        plugins = [
            MockPlugin("child", ["parent"]),
            MockPlugin("parent", []),
            MockPlugin("other", []),
        ]
        self.registry._register_with_dependencies(plugins)

        with self.assertLogs("fastapi_app.lib.plugins.plugin_registry", level="WARNING") as logs:
            result = self.registry.get_dependency("child", "other")

        self.assertIsNone(result)
        self.assertTrue(
            any("undeclared dependency" in log for log in logs.output)
        )

    def test_get_dependency_nonexistent_plugin(self):
        """Requesting dependency for nonexistent plugin returns None."""
        result = self.registry.get_dependency("nonexistent", "something")
        self.assertIsNone(result)


class TestPluginContextDependency(unittest.TestCase):
    """Test PluginContext.get_dependency method."""

    def setUp(self):
        self.registry = PluginRegistry()
        plugins = [
            MockPlugin("child", ["parent"]),
            MockPlugin("parent", []),
        ]
        self.registry._register_with_dependencies(plugins)

    def test_context_get_dependency(self):
        """PluginContext can retrieve declared dependencies."""
        context = PluginContext(
            app=None, user=None, plugin_id="child", registry=self.registry
        )

        dependency = context.get_dependency("parent")
        self.assertIsNotNone(dependency)
        self.assertEqual(dependency.metadata["id"], "parent")

    def test_context_get_dependency_no_registry(self):
        """Context without registry returns None."""
        context = PluginContext(app=None, user=None, plugin_id="child", registry=None)

        result = context.get_dependency("parent")
        self.assertIsNone(result)

    def test_context_get_dependency_no_plugin_id(self):
        """Context without plugin_id returns None."""
        context = PluginContext(
            app=None, user=None, plugin_id=None, registry=self.registry
        )

        result = context.get_dependency("parent")
        self.assertIsNone(result)


class TestPluginManagerDependencyContext(unittest.IsolatedAsyncioTestCase):
    """Test that PluginManager passes dependency context to plugins."""

    def setUp(self):
        PluginManager._instance = None
        self.manager = PluginManager.get_instance()

    def tearDown(self):
        PluginManager._instance = None

    async def test_execute_plugin_has_dependency_context(self):
        """Plugin execution receives context with dependency access."""

        class DependencyAwarePlugin(Plugin):
            @property
            def metadata(self):
                return {
                    "id": "dependent",
                    "name": "Dependent Plugin",
                    "description": "Test",
                    "category": "test",
                    "version": "1.0.0",
                    "required_roles": ["*"],
                    "dependencies": ["provider"],
                }

            def get_endpoints(self):
                return {"execute": self.execute}

            async def execute(self, context, params):
                dep = context.get_dependency("provider")
                if dep:
                    return {"has_dependency": True, "dep_id": dep.metadata["id"]}
                return {"has_dependency": False}

        class ProviderPlugin(Plugin):
            @property
            def metadata(self):
                return {
                    "id": "provider",
                    "name": "Provider Plugin",
                    "description": "Test",
                    "category": "test",
                    "version": "1.0.0",
                    "required_roles": ["*"],
                }

            def get_endpoints(self):
                return {"execute": self.execute}

            async def execute(self, context, params):
                return {"provided": True}

        # Register plugins through the dependency system
        self.manager.registry._register_with_dependencies(
            [DependencyAwarePlugin(), ProviderPlugin()]
        )

        # Execute the dependent plugin
        result = await self.manager.execute_plugin("dependent", "execute", {})

        self.assertTrue(result["has_dependency"])
        self.assertEqual(result["dep_id"], "provider")


if __name__ == "__main__":
    unittest.main()
