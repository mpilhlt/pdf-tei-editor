"""
Plugin registry for discovering and managing backend plugins.

This module handles filesystem-based plugin discovery, validation,
and role-based filtering.
"""

import importlib.util
import logging
from pathlib import Path
from typing import Any

from fastapi_app.lib.plugin_base import Plugin, PluginContext

logger = logging.getLogger(__name__)


class PluginRegistry:
    """
    Registry for discovering and managing plugins from the filesystem.
    """

    def __init__(self):
        """Initialize empty plugin registry."""
        self._plugins: dict[str, Plugin] = {}
        self._plugin_metadata: dict[str, dict[str, Any]] = {}

    def discover_plugins(self, plugin_dirs: list[Path]) -> None:
        """
        Discover plugins from the specified directories.

        Each plugin directory should contain a plugin.py file with a Plugin subclass.
        Uses two-phase registration to handle dependencies:
        1. Load all plugins
        2. Register in dependency order

        Args:
            plugin_dirs: List of directories to search for plugins
        """
        pending_plugins: list[Plugin] = []

        for plugin_dir in plugin_dirs:
            if not plugin_dir.exists():
                logger.warning(f"Plugin directory does not exist: {plugin_dir}")
                continue

            if not plugin_dir.is_dir():
                logger.warning(f"Plugin path is not a directory: {plugin_dir}")
                continue

            # Iterate through subdirectories (each is a potential plugin)
            for plugin_path in plugin_dir.iterdir():
                if not plugin_path.is_dir():
                    continue

                plugin_file = plugin_path / "plugin.py"
                if not plugin_file.exists():
                    continue

                try:
                    plugin = self._load_plugin(plugin_path, plugin_file)
                    if plugin:
                        pending_plugins.append(plugin)
                except Exception as e:
                    logger.error(f"Failed to load plugin from {plugin_path}: {e}")

        # Second pass: register with dependency resolution
        self._register_with_dependencies(pending_plugins)

    def _load_plugin(self, plugin_path: Path, plugin_file: Path) -> Plugin | None:
        """
        Load a plugin from a plugin.py file.

        Args:
            plugin_path: Path to plugin directory
            plugin_file: Path to plugin.py file

        Returns:
            Plugin instance or None if loading failed
        """
        try:
            # Use standard package import to support relative imports
            plugin_name = plugin_path.name
            module_name = f"fastapi_app.plugins.{plugin_name}.plugin"

            # Try standard import first (works when fastapi_app is in sys.path)
            try:
                import importlib
                module = importlib.import_module(module_name)
            except ModuleNotFoundError:
                # Fallback to spec-based loading for edge cases
                spec = importlib.util.spec_from_file_location(module_name, plugin_file)
                if spec is None or spec.loader is None:
                    logger.error(f"Could not load spec for {plugin_file}")
                    return None

                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)

            # Find Plugin subclass in module
            plugin_class = None
            for item_name in dir(module):
                item = getattr(module, item_name)
                if (
                    isinstance(item, type)
                    and issubclass(item, Plugin)
                    and item is not Plugin
                ):
                    plugin_class = item
                    break

            if plugin_class is None:
                logger.warning(f"No Plugin subclass found in {plugin_file}")
                return None

            # Check availability before instantiating
            if not plugin_class.is_available():
                logger.info(f"Plugin in {plugin_file} is not available, skipping")
                return None

            # Instantiate plugin
            return plugin_class()

        except Exception as e:
            logger.error(f"Error loading plugin from {plugin_file}: {e}")
            return None

    def _register_plugin(self, plugin: Plugin) -> None:
        """
        Register a plugin instance.

        Args:
            plugin: Plugin instance to register

        Raises:
            ValueError: If plugin metadata is invalid
        """
        # Validate metadata
        metadata = plugin.metadata
        required_fields = ["id", "name", "description", "category", "version", "required_roles"]

        for field in required_fields:
            if field not in metadata:
                raise ValueError(f"Plugin metadata missing required field: {field}")

        plugin_id = metadata["id"]

        # Check for duplicate IDs
        if plugin_id in self._plugins:
            logger.warning(f"Plugin with id '{plugin_id}' already registered, skipping")
            return

        # Register
        self._plugins[plugin_id] = plugin
        self._plugin_metadata[plugin_id] = metadata
        logger.info(f"Registered plugin: {plugin_id} ({metadata['name']})")

    def _register_with_dependencies(self, plugins: list[Plugin]) -> None:
        """
        Register plugins in dependency order using topological sort.

        Args:
            plugins: List of plugin instances to register
        """
        # Build plugin map by ID
        plugin_map = {p.metadata["id"]: p for p in plugins}
        registered: set[str] = set()

        def register_plugin(plugin_id: str, path: list[str]) -> bool:
            """
            Recursively register a plugin and its dependencies.

            Args:
                plugin_id: Plugin ID to register
                path: Current dependency path (for cycle detection)

            Returns:
                True if registration succeeded, False otherwise
            """
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

            # Register dependencies first
            for dep_id in deps:
                if not register_plugin(dep_id, path + [plugin_id]):
                    logger.error(
                        f"Plugin {plugin_id} not registered due to "
                        f"failed dependency: {dep_id}"
                    )
                    return False

            # Now register this plugin
            try:
                self._register_plugin(plugin)
                registered.add(plugin_id)
                return True
            except Exception as e:
                logger.error(f"Failed to register plugin {plugin_id}: {e}")
                return False

        # Register all plugins
        for plugin_id in plugin_map:
            register_plugin(plugin_id, [])

    def get_dependency(self, plugin_id: str, dependency_id: str) -> Plugin | None:
        """
        Get a dependency plugin instance.

        Only returns the dependency if it was declared in the requesting plugin's
        metadata. Logs a warning if an undeclared dependency is requested.

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

    def get_plugin(self, plugin_id: str) -> Plugin | None:
        """
        Get a plugin by ID.

        Args:
            plugin_id: Plugin identifier

        Returns:
            Plugin instance or None if not found
        """
        return self._plugins.get(plugin_id)

    def get_plugins(
        self, category: str | None = None, user_roles: list[str] | None = None
    ) -> list[dict[str, Any]]:
        """
        Get plugin metadata filtered by category and user roles.

        Args:
            category: Optional category filter
            user_roles: User's roles for access control (None = no filtering)

        Returns:
            List of plugin metadata dicts
        """
        filtered = []

        for plugin_id, metadata in self._plugin_metadata.items():
            # Filter by category
            if category and metadata.get("category") != category:
                continue

            # Filter by required roles (only if user_roles is explicitly provided)
            if user_roles is not None:
                required_roles = metadata.get("required_roles", [])

                # If plugin requires specific roles (not empty and not just "*")
                if required_roles and required_roles != ["*"]:
                    # Check if user has wildcard role or any of the required roles
                    has_access = '*' in user_roles or any(role in user_roles for role in required_roles)
                    if not has_access:
                        continue
                # If plugin has required_roles=[] or ["*"], it's accessible to everyone

            # Include in results (exclude internal fields if needed)
            result = {
                "id": metadata["id"],
                "name": metadata["name"],
                "description": metadata["description"],
                "category": metadata["category"],
                "version": metadata["version"],
            }

            # Include optional endpoints metadata if present
            if "endpoints" in metadata:
                result["endpoints"] = metadata["endpoints"]

            filtered.append(result)

        return filtered

    def get_all_plugins(self) -> dict[str, Plugin]:
        """
        Get all registered plugins (no filtering).

        Returns:
            Dict mapping plugin IDs to Plugin instances
        """
        return self._plugins.copy()

    async def initialize_all(self, context: Any) -> None:
        """
        Initialize all registered plugins.

        Creates a per-plugin context with plugin_id and registry so that
        plugins can access their declared dependencies during initialization.

        Args:
            context: Base plugin context (provides app reference)
        """
        for plugin_id, plugin in self._plugins.items():
            try:
                plugin_context = PluginContext(
                    app=context.app,
                    plugin_id=plugin_id,
                    registry=self,
                )
                await plugin.initialize(plugin_context)
                metadata = self._plugin_metadata.get(plugin_id, {})
                logger.info(f"Initialized plugin: {plugin_id} ({metadata.get('name', 'unknown')})")
            except Exception as e:
                logger.error(f"Error initializing plugin {plugin_id}: {e}")

    async def cleanup_all(self) -> None:
        """
        Cleanup all registered plugins.
        """
        for plugin_id, plugin in self._plugins.items():
            try:
                await plugin.cleanup()
            except Exception as e:
                logger.error(f"Error cleaning up plugin {plugin_id}: {e}")
