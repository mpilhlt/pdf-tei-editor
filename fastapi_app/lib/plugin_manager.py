"""
Plugin manager for application-wide plugin lifecycle management.

This module provides a singleton manager that handles plugin discovery,
initialization, route registration, and execution.
"""

import logging
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI

from fastapi_app.lib.plugin_base import PluginContext
from fastapi_app.lib.plugin_registry import PluginRegistry

logger = logging.getLogger(__name__)


class PluginManager:
    """
    Singleton manager for plugin lifecycle and route registration.
    """

    _instance: "PluginManager | None" = None

    def __init__(self):
        """Initialize plugin manager (use get_instance() instead)."""
        if PluginManager._instance is not None:
            raise RuntimeError("Use PluginManager.get_instance() instead")

        self.registry = PluginRegistry()
        self._app: FastAPI | None = None
        self._initialized = False

    @classmethod
    def get_instance(cls) -> "PluginManager":
        """
        Get or create the singleton plugin manager instance.

        Returns:
            PluginManager singleton instance
        """
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def discover_plugins(self) -> None:
        """
        Discover plugins from configured directories.

        Searches:
        1. Built-in plugins: fastapi_app/plugins/
        2. Additional paths from FASTAPI_PLUGIN_PATHS environment variable
        """
        plugin_dirs: list[Path] = []

        # Built-in plugins directory
        builtin_dir = Path(__file__).parent.parent / "plugins"
        plugin_dirs.append(builtin_dir)

        # Additional plugin paths from environment
        env_paths = os.getenv("FASTAPI_PLUGIN_PATHS", "")
        if env_paths:
            # Split by colon on Unix, semicolon on Windows
            separator = ";" if os.name == "nt" else ":"
            for path_str in env_paths.split(separator):
                path_str = path_str.strip()
                if path_str:
                    plugin_dirs.append(Path(path_str))

        logger.info(f"Discovering plugins from {len(plugin_dirs)} directories")
        self.registry.discover_plugins(plugin_dirs)

    def register_plugin_routes(self, app: FastAPI) -> None:
        """
        Register custom routes from plugins that have a routes.py file.

        Args:
            app: FastAPI application instance
        """
        self._app = app

        # Iterate through all registered plugins and try to register their routes
        for plugin_id in self.registry.get_all_plugins().keys():
            try:
                self._try_register_plugin_routes(app, plugin_id)
            except Exception as e:
                logger.error(f"Error registering routes for plugin {plugin_id}: {e}")

    def _try_register_plugin_routes(self, app: FastAPI, plugin_id: str) -> None:
        """
        Try to load and register routes.py for a plugin.

        Args:
            app: FastAPI application instance
            plugin_id: Plugin identifier
        """
        # Search plugin directories for this plugin's routes.py
        plugin_dirs = self._get_plugin_dirs()

        # Try both hyphenated and underscored directory names
        # (plugin_id uses hyphens, directory names use underscores)
        dir_names = [plugin_id, plugin_id.replace("-", "_")]

        for base_dir in plugin_dirs:
            for dir_name in dir_names:
                plugin_dir = base_dir / dir_name
                routes_file = plugin_dir / "routes.py"

                if routes_file.exists():
                    try:
                        # Load the routes module
                        import importlib.util

                        module_name = f"plugin_{plugin_id}_routes"
                        spec = importlib.util.spec_from_file_location(
                            module_name, routes_file
                        )
                        if spec is None or spec.loader is None:
                            logger.warning(f"Could not create spec for {routes_file}")
                            continue

                        module = importlib.util.module_from_spec(spec)
                        spec.loader.exec_module(module)

                        # Look for 'router' in the module
                        if hasattr(module, "router"):
                            app.include_router(module.router)
                            logger.info(f"Registered custom routes for plugin: {plugin_id}")
                            return
                        else:
                            logger.warning(f"No 'router' found in {routes_file}")

                    except Exception as e:
                        logger.error(
                            f"Error loading routes.py for plugin {plugin_id}: {e}",
                            exc_info=True
                        )

    def _get_plugin_dirs(self) -> list[Path]:
        """
        Get list of plugin directories to search.

        Returns:
            List of plugin directory paths
        """
        plugin_dirs: list[Path] = []

        # Built-in plugins
        builtin_dir = Path(__file__).parent.parent / "plugins"
        plugin_dirs.append(builtin_dir)

        # Additional paths from environment
        env_paths = os.getenv("FASTAPI_PLUGIN_PATHS", "")
        if env_paths:
            separator = ";" if os.name == "nt" else ":"
            for path_str in env_paths.split(separator):
                path_str = path_str.strip()
                if path_str:
                    plugin_dirs.append(Path(path_str))

        return plugin_dirs

    async def initialize_plugins(self, app: FastAPI) -> None:
        """
        Initialize all plugins with application context.

        Args:
            app: FastAPI application instance
        """
        if self._initialized:
            return

        context = PluginContext(app=app)
        await self.registry.initialize_all(context)
        self._initialized = True
        logger.info("All plugins initialized")

    async def shutdown_plugins(self) -> None:
        """
        Cleanup all plugins on application shutdown.
        """
        await self.registry.cleanup_all()
        logger.info("All plugins cleaned up")

    def get_plugins(
        self, category: str | None = None, user_roles: list[str] | None = None
    ) -> list[dict[str, Any]]:
        """
        Get plugin metadata filtered by category and user roles.

        Args:
            category: Optional category filter
            user_roles: User's roles for access control

        Returns:
            List of plugin metadata dicts
        """
        return self.registry.get_plugins(category=category, user_roles=user_roles)

    async def execute_plugin(
        self, plugin_id: str, endpoint: str, params: dict[str, Any], user: dict | None = None
    ) -> Any:
        """
        Execute a plugin endpoint.

        Args:
            plugin_id: Plugin identifier
            endpoint: Endpoint name to execute
            params: Parameters to pass to endpoint
            user: Current user dict (for context)

        Returns:
            Result from plugin endpoint

        Raises:
            ValueError: If plugin or endpoint not found
        """
        plugin = self.registry.get_plugin(plugin_id)
        if plugin is None:
            raise ValueError(f"Plugin not found: {plugin_id}")

        endpoints = plugin.get_endpoints()
        if endpoint not in endpoints:
            raise ValueError(f"Endpoint not found: {plugin_id}.{endpoint}")

        endpoint_func = endpoints[endpoint]

        # Create context for this execution
        context = PluginContext(app=self._app, user=user)

        # Execute endpoint (pass both context and params)
        return await endpoint_func(context, params)
