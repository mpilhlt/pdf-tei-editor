"""
Plugin manager for application-wide plugin lifecycle management.

This module provides a singleton manager that handles plugin discovery,
initialization, route registration, and execution.
"""

import asyncio
import logging
import os
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI

from fastapi_app.config import get_settings
from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugins.plugin_base import PluginContext
from fastapi_app.lib.plugins.plugin_gate import GatedStaticFiles, plugin_gate
from fastapi_app.lib.plugins.plugin_registry import ChangePlan, PluginRegistry
from fastapi_app.lib.utils.config_utils import get_config

logger = logging.getLogger(__name__)

DISABLED_CONFIG_KEY = "plugins.disabled"


class CascadeRequired(Exception):
    """Raised when a toggle affects other plugins and the caller did not confirm."""

    def __init__(self, affected: list[str], direction: str):
        super().__init__(f"Cascade required ({direction}): {', '.join(affected)}")
        self.affected = affected
        self.direction = direction


class PluginChangeError(Exception):
    """Raised when a plugin cannot be toggled; carries the HTTP status to report."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


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
        self._lock = asyncio.Lock()

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
        builtin_dir = get_settings().plugins_code_dir
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
        self.registry.discover_plugins(plugin_dirs, builtin_dir=builtin_dir)
        self.load_disabled()

    def load_disabled(self) -> None:
        """Load the explicitly disabled plugin ids from config."""
        disabled = get_config().get(DISABLED_CONFIG_KEY, default=[])
        self.registry.set_disabled({str(p) for p in disabled})

    def register_plugin_routes(self, app: FastAPI) -> None:
        """
        Register custom routes from plugins that have a routes.py file.
        Also mounts static file directories for plugins with a 'static' subdirectory.

        Args:
            app: FastAPI application instance
        """
        self._app = app

        # Iterate through all registered plugins and try to register their routes
        for plugin_id in self.registry.get_all_plugins().keys():
            try:
                self._try_register_plugin_routes(app, plugin_id)
                self._try_mount_plugin_static_files(app, plugin_id)
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
                        # Load the routes module using its proper dotted module name
                        # so relative imports work correctly.
                        import importlib
                        import importlib.util
                        import sys

                        project_root = get_settings().project_root_dir
                        rel = routes_file.relative_to(project_root).with_suffix("")
                        module_name = ".".join(rel.parts)
                        package_name = ".".join(rel.parts[:-1])

                        # Ensure all parent packages are importable
                        if package_name not in sys.modules:
                            importlib.import_module(package_name)

                        spec = importlib.util.spec_from_file_location(
                            module_name, routes_file,
                            submodule_search_locations=[]
                        )
                        if spec is None or spec.loader is None:
                            logger.warning(f"Could not create spec for {routes_file}")
                            continue

                        module = importlib.util.module_from_spec(spec)
                        module.__package__ = package_name
                        sys.modules[module_name] = module
                        spec.loader.exec_module(module)

                        # Look for 'router' in the module
                        if hasattr(module, "router"):
                            app.include_router(
                                module.router, dependencies=[Depends(plugin_gate(plugin_id))]
                            )
                            logger.info(f"Registered custom routes for plugin: {plugin_id}")
                            return
                        else:
                            logger.warning(f"No 'router' found in {routes_file}")

                    except Exception as e:
                        logger.error(
                            f"Error loading routes.py for plugin {plugin_id}: {e}",
                            exc_info=True
                        )

    def _try_mount_plugin_static_files(self, app: FastAPI, plugin_id: str) -> None:
        """
        Try to mount static files from plugin's static directory.

        Args:
            app: FastAPI application instance
            plugin_id: Plugin identifier
        """
        plugin_dirs = self._get_plugin_dirs()
        dir_names = [plugin_id, plugin_id.replace("-", "_")]

        for base_dir in plugin_dirs:
            for dir_name in dir_names:
                plugin_dir = base_dir / dir_name
                static_dir = plugin_dir / "static"

                if static_dir.exists() and static_dir.is_dir():
                    try:
                        # Mount at /api/plugins/{plugin_id}/static/
                        mount_path = f"/api/plugins/{plugin_id}/static"
                        app.mount(
                            mount_path,
                            GatedStaticFiles(plugin_id=plugin_id, directory=str(static_dir)),
                            name=f"plugin_{plugin_id}_static"
                        )
                        logger.info(f"Mounted static files for plugin {plugin_id} at {mount_path}")
                        return
                    except Exception as e:
                        logger.error(f"Error mounting static files for plugin {plugin_id}: {e}")

    def _get_plugin_dirs(self) -> list[Path]:
        """
        Get list of plugin directories to search.

        Returns:
            List of plugin directory paths
        """
        plugin_dirs: list[Path] = []

        # Built-in plugins
        builtin_dir = get_settings().plugins_code_dir
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
        if plugin is None or not self.registry.is_active(plugin_id):
            raise ValueError(f"Plugin not found: {plugin_id}")

        endpoints = plugin.get_endpoints()
        if endpoint not in endpoints:
            raise ValueError(f"Endpoint not found: {plugin_id}.{endpoint}")

        endpoint_func = endpoints[endpoint]

        # Create context for this execution with plugin_id and registry for dependency access
        context = PluginContext(
            app=self._app,
            user=user,
            plugin_id=plugin_id,
            registry=self.registry,
        )

        # Execute endpoint (pass both context and params)
        return await endpoint_func(context, params)

    async def set_plugin_enabled(
        self, plugin_id: str, enabled: bool, cascade: bool = False, user: dict | None = None
    ) -> dict[str, Any]:
        """
        Enable or disable a plugin and apply lifecycle hooks without a restart.

        Args:
            plugin_id: Plugin identifier
            enabled: True to enable, False to disable
            cascade: Confirm that other plugins may be (de)activated as a consequence
            user: Acting user (for the audit log line)

        Returns:
            {"changed": {id: status}, "errors": {id: message}, "reload_required": True}

        Raises:
            PluginChangeError: unknown plugin (404); protected, unavailable or failed (409);
                config write failed (500)
            CascadeRequired: other plugins are affected and cascade is False
        """
        async with self._lock:
            registry = self.registry
            record = registry.get_record(plugin_id)
            if record is None:
                raise PluginChangeError(404, f"Plugin not found: {plugin_id}")
            if record.load_status != "ok":
                raise PluginChangeError(409, f"Plugin is {record.load_status}: {record.error}")
            if not enabled and record.metadata.get("protected", False):
                raise PluginChangeError(409, f"Plugin {plugin_id} is protected and cannot be disabled")

            disabled = registry.disabled
            if enabled:
                needed = [d for d in registry.dependencies(plugin_id, transitive=True) if d in disabled]
                if needed and not cascade:
                    raise CascadeRequired(needed, "enable")
                new_disabled = disabled - {plugin_id} - set(needed)
            else:
                new_disabled = disabled | {plugin_id}
                affected = [p for p in registry.plan(new_disabled).deactivate if p != plugin_id]
                if affected and not cascade:
                    raise CascadeRequired(affected, "disable")

            plan = registry.plan(new_disabled)
            ok, message = get_config().set(
                DISABLED_CONFIG_KEY,
                sorted(new_disabled),
                value_type="array",
                description="IDs of backend plugins disabled by an administrator (managed by the Plugin Manager)",
            )
            if not ok:
                raise PluginChangeError(500, f"Could not save plugin state: {message}")
            registry.set_disabled(new_disabled)

            errors = await self._apply_plan(plan)
            logger.info(
                "Plugin %s %s by %s (deactivated: %s, activated: %s)",
                plugin_id,
                "enabled" if enabled else "disabled",
                (user or {}).get("username", "unknown"),
                plan.deactivate,
                plan.activate,
            )
            touched = {plugin_id, *plan.deactivate, *plan.activate}
            return {
                "changed": {p: registry.status(p)[0] for p in touched},
                "errors": errors,
                "reload_required": True,
            }

    async def _apply_plan(self, plan: ChangePlan) -> dict[str, str]:
        """
        Run cleanup() for deactivated and initialize() for activated plugins.

        Returns:
            Error messages by plugin id
        """
        errors: dict[str, str] = {}
        ext_registry = FrontendExtensionRegistry.get_instance()
        for pid in plan.deactivate:
            record = self.registry.get_record(pid)
            if record is None or record.plugin is None:
                continue
            if record.initialized:
                try:
                    await record.plugin.cleanup()
                except Exception as e:
                    logger.error(f"Error cleaning up plugin {pid}: {e}", exc_info=True)
                    errors[pid] = f"cleanup() failed: {e}"
            record.initialized = False
            ext_registry.unregister_plugin(pid)
        for pid in plan.activate:
            record = self.registry.get_record(pid)
            if record is None or record.plugin is None or not self.registry.is_active(pid):
                continue
            context = PluginContext(app=self._app, plugin_id=pid, registry=self.registry)
            try:
                await record.plugin.initialize(context)
                record.initialized = True
            except Exception as e:
                logger.error(f"Error initializing plugin {pid}: {e}", exc_info=True)
                self.registry.mark_failed(pid, f"initialize() failed: {e}")
                errors[pid] = str(e)
        return errors
