"""
Plugin registry for discovering and managing backend plugins.

This module handles filesystem-based plugin discovery, validation,
role-based filtering, and the derived enabled/disabled status of plugins.
"""

import importlib
import importlib.util
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext

logger = logging.getLogger(__name__)


@dataclass
class PluginRecord:
    """Discovery result for one plugin, including plugins that could not be activated."""

    id: str
    metadata: dict[str, Any]
    plugin: Plugin | None
    directory: Path | None = None
    external: bool = False
    load_status: str = "ok"  # "ok" | "unavailable" | "failed"
    error: str | None = None
    initialized: bool = False

    @property
    def dependencies(self) -> list[str]:
        """IDs of plugins this plugin depends on."""
        return list(self.metadata.get("dependencies", []))


@dataclass
class ChangePlan:
    """Plugins whose effective state changes, in the order lifecycle hooks must run."""

    deactivate: list[str] = field(default_factory=list)  # dependents first
    activate: list[str] = field(default_factory=list)  # dependencies first


class PluginRegistry:
    """
    Registry for discovering and managing plugins from the filesystem.

    Status of a plugin is derived: it is `active` when loaded successfully, not in the
    explicitly disabled set and all of its dependencies are active.
    """

    def __init__(self):
        """Initialize empty plugin registry."""
        self._plugins: dict[str, Plugin] = {}
        self._plugin_metadata: dict[str, dict[str, Any]] = {}
        self._records: dict[str, PluginRecord] = {}
        self._order: list[str] = []  # registered plugin ids, dependencies first
        self._disabled: set[str] = set()

    def discover_plugins(self, plugin_dirs: list[Path], builtin_dir: Path | None = None) -> None:
        """
        Discover plugins from the specified directories.

        Each plugin directory should contain a plugin.py file with a Plugin subclass.
        Uses two-phase registration to handle dependencies:
        1. Load all plugins
        2. Register in dependency order

        Plugins that are unavailable or fail to load are kept as records with a reason.

        Args:
            plugin_dirs: List of directories to search for plugins
            builtin_dir: Directory of built-in plugins; plugins elsewhere are marked external
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
            for plugin_path in sorted(plugin_dir.iterdir()):
                if not plugin_path.is_dir():
                    continue

                plugin_file = plugin_path / "plugin.py"
                if not plugin_file.exists():
                    continue

                record = self._load_plugin(plugin_path, plugin_file)
                record.external = builtin_dir is not None and plugin_dir != builtin_dir
                if record.load_status == "ok" and record.plugin is not None:
                    self._records.setdefault(record.id, record)
                    pending_plugins.append(record.plugin)
                else:
                    self._records.setdefault(record.id, record)

        # Second pass: register with dependency resolution
        self._register_with_dependencies(pending_plugins)

    @staticmethod
    def _failed_record(plugin_path: Path, error: str) -> PluginRecord:
        """Build a record for a plugin whose metadata could not be obtained."""
        plugin_id = plugin_path.name.replace("_", "-")
        return PluginRecord(
            id=plugin_id,
            metadata={
                "id": plugin_id, "name": plugin_path.name, "description": "",
                "category": "unknown", "version": "", "required_roles": [],
            },
            plugin=None,
            directory=plugin_path,
            load_status="failed",
            error=error,
        )

    def _load_plugin(self, plugin_path: Path, plugin_file: Path) -> PluginRecord:
        """
        Load a plugin from a plugin.py file.

        Args:
            plugin_path: Path to plugin directory
            plugin_file: Path to plugin.py file

        Returns:
            PluginRecord; load_status is "ok", "unavailable" or "failed"
        """
        try:
            # Use standard package import to support relative imports
            plugin_name = plugin_path.name
            module_name = f"fastapi_app.plugins.{plugin_name}.plugin"

            # Try standard import first (works when fastapi_app is in sys.path)
            try:
                module = importlib.import_module(module_name)
            except ModuleNotFoundError:
                # Fallback to spec-based loading for edge cases
                spec = importlib.util.spec_from_file_location(module_name, plugin_file)
                if spec is None or spec.loader is None:
                    logger.error(f"Could not load spec for {plugin_file}")
                    return self._failed_record(plugin_path, "Could not load module spec")

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
                return self._failed_record(plugin_path, "No Plugin subclass found")

            # Instantiate first so __init__ can populate config (e.g. via get_plugin_config),
            # then check availability which may depend on that config being written.
            plugin_instance = plugin_class()
            metadata = plugin_instance.metadata
            plugin_id = metadata.get("id", plugin_path.name.replace("_", "-"))

            if not plugin_class.is_available():
                logger.info(f"Plugin in {plugin_file} is not available, skipping")
                return PluginRecord(
                    id=plugin_id, metadata=metadata, plugin=plugin_instance, directory=plugin_path,
                    load_status="unavailable",
                    error=plugin_class.unavailable_reason() or "Not available in this environment",
                )

            return PluginRecord(id=plugin_id, metadata=metadata, plugin=plugin_instance, directory=plugin_path)

        except Exception as e:
            logger.error(f"Error loading plugin from {plugin_file}: {e}")
            return self._failed_record(plugin_path, f"{type(e).__name__}: {e}")

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

        for field_name in required_fields:
            if field_name not in metadata:
                raise ValueError(f"Plugin metadata missing required field: {field_name}")

        plugin_id = metadata["id"]

        # Check for duplicate IDs
        if plugin_id in self._plugins:
            logger.warning(f"Plugin with id '{plugin_id}' already registered, skipping")
            return

        # Register
        self._plugins[plugin_id] = plugin
        self._plugin_metadata[plugin_id] = metadata
        self._records.setdefault(plugin_id, PluginRecord(id=plugin_id, metadata=metadata, plugin=plugin))
        self._order.append(plugin_id)
        logger.info(f"Registered plugin: {plugin_id} ({metadata['name']})")

    def _fail(self, plugin_id: str, reason: str) -> None:
        """Mark a plugin record as failed with a reason."""
        record = self._records.get(plugin_id)
        if record is not None:
            record.load_status = "failed"
            record.error = reason

    def _register_with_dependencies(self, plugins: list[Plugin]) -> None:
        """
        Register plugins in dependency order using topological sort.

        Plugins that cannot be registered (missing/unavailable dependency, cycle,
        invalid metadata) are marked as failed with a reason.

        Args:
            plugins: List of plugin instances to register
        """
        # Build plugin map by ID
        plugin_map = {p.metadata["id"]: p for p in plugins}
        for pid, p in plugin_map.items():
            self._records.setdefault(pid, PluginRecord(id=pid, metadata=p.metadata, plugin=p))
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
                for member in path[path.index(plugin_id):]:
                    self._fail(member, f"Circular dependency: {cycle}")
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
                    dep_record = self._records.get(dep_id)
                    if dep_record is not None and dep_record.load_status == "unavailable":
                        reason = f"Dependency {dep_id} is unavailable: {dep_record.error}"
                    elif dep_record is None:
                        reason = f"Missing dependency: {dep_id}"
                    else:
                        reason = f"Dependency {dep_id} could not be loaded"
                    record = self._records.get(plugin_id)
                    if record is not None and record.load_status == "ok":
                        self._fail(plugin_id, reason)
                    return False

            # Now register this plugin
            try:
                self._register_plugin(plugin)
                registered.add(plugin_id)
                return True
            except Exception as e:
                logger.error(f"Failed to register plugin {plugin_id}: {e}")
                self._fail(plugin_id, str(e))
                return False

        # Register all plugins
        for plugin_id in plugin_map:
            register_plugin(plugin_id, [])

    # ---- status, graph and change planning -------------------------------------

    def add_unavailable(
        self, plugin_id: str, plugin: Plugin, directory: Path | None, reason: str | None
    ) -> None:
        """Record a plugin that is not available in this environment."""
        self._records[plugin_id] = PluginRecord(
            id=plugin_id, metadata=plugin.metadata, plugin=plugin, directory=directory,
            load_status="unavailable", error=reason or "Not available in this environment",
        )

    def mark_failed(self, plugin_id: str, reason: str) -> None:
        """Mark a plugin as failed (e.g. its initialize() raised)."""
        self._fail(plugin_id, reason)

    def set_disabled(self, disabled: set[str]) -> None:
        """Replace the set of explicitly disabled plugin ids."""
        self._disabled = set(disabled)

    @property
    def disabled(self) -> set[str]:
        """Copy of the explicitly disabled plugin ids."""
        return set(self._disabled)

    def get_records(self) -> list[PluginRecord]:
        """All discovered plugins, whatever their status."""
        return list(self._records.values())

    def get_record(self, plugin_id: str) -> PluginRecord | None:
        """Record for a plugin id, or None if unknown."""
        return self._records.get(plugin_id)

    def _compute_active(self, disabled: set[str]) -> set[str]:
        """Effective active set for a hypothetical disabled set (dependencies first)."""
        active: set[str] = set()
        for pid in self._order:
            record = self._records[pid]
            if record.load_status != "ok" or pid in disabled:
                continue
            if all(dep in active for dep in record.dependencies):
                active.add(pid)
        return active

    def status(self, plugin_id: str) -> tuple[str, str | None]:
        """
        Derived status of a plugin.

        Returns:
            (status, reason) where status is active, disabled, inactive, unavailable or failed
        """
        record = self._records[plugin_id]
        if record.load_status == "unavailable":
            return "unavailable", record.error
        if record.load_status == "failed":
            return "failed", record.error
        if plugin_id in self._disabled:
            return "disabled", None
        active = self._compute_active(self._disabled)
        if plugin_id in active:
            return "active", None
        waiting = [d for d in record.dependencies if d not in active]
        return "inactive", "Waiting for " + ", ".join(waiting)

    def is_active(self, plugin_id: str) -> bool:
        """True if the plugin is loaded, enabled and all dependencies are active."""
        return plugin_id in self._compute_active(self._disabled)

    def dependents(self, plugin_id: str, transitive: bool = False) -> list[str]:
        """Plugins that depend on plugin_id (directly, or also indirectly)."""
        direct = [r.id for r in self._records.values() if plugin_id in r.dependencies]
        if not transitive:
            return direct
        result: list[str] = []
        for child in direct:
            for pid in [child, *self.dependents(child, transitive=True)]:
                if pid not in result:
                    result.append(pid)
        return result

    def dependencies(self, plugin_id: str, transitive: bool = False) -> list[str]:
        """Known plugins that plugin_id depends on (directly, or also indirectly)."""
        record = self._records[plugin_id]
        result: list[str] = []
        for dep in record.dependencies:
            if dep not in self._records:
                continue
            for pid in [dep, *(self.dependencies(dep, True) if transitive else [])]:
                if pid not in result:
                    result.append(pid)
        return result

    def plan(self, new_disabled: set[str]) -> ChangePlan:
        """Compute which plugins change effective state if the disabled set became new_disabled."""
        before = self._compute_active(self._disabled)
        after = self._compute_active(new_disabled)
        return ChangePlan(
            deactivate=[p for p in reversed(self._order) if p in before and p not in after],
            activate=[p for p in self._order if p in after and p not in before],
        )

    # ---- lookup ----------------------------------------------------------------

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
        Get metadata of active plugins filtered by category and user roles.

        Args:
            category: Optional category filter
            user_roles: User's roles for access control (None = no filtering)

        Returns:
            List of plugin metadata dicts
        """
        filtered = []

        for plugin_id, metadata in self._plugin_metadata.items():
            # Disabled, inactive and failed plugins are not offered
            if not self.is_active(plugin_id):
                continue

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
        Initialize all active plugins, dependencies first.

        Creates a per-plugin context with plugin_id and registry so that
        plugins can access their declared dependencies during initialization.
        A plugin whose initialize() raises is marked failed.

        Args:
            context: Base plugin context (provides app reference)
        """
        for plugin_id in list(self._order):
            if not self.is_active(plugin_id):
                continue
            plugin = self._plugins[plugin_id]
            try:
                plugin_context = PluginContext(
                    app=context.app,
                    plugin_id=plugin_id,
                    registry=self,
                )
                await plugin.initialize(plugin_context)
                self._records[plugin_id].initialized = True
                metadata = self._plugin_metadata.get(plugin_id, {})
                logger.info(f"Initialized plugin: {plugin_id} ({metadata.get('name', 'unknown')})")
            except Exception as e:
                logger.error(f"Error initializing plugin {plugin_id}: {e}")
                self._fail(plugin_id, f"initialize() failed: {e}")

    async def cleanup_all(self) -> None:
        """
        Cleanup all initialized plugins.
        """
        for plugin_id in reversed(self._order):
            record = self._records[plugin_id]
            if not record.initialized:
                continue
            try:
                await self._plugins[plugin_id].cleanup()
            except Exception as e:
                logger.error(f"Error cleaning up plugin {plugin_id}: {e}")
            record.initialized = False
