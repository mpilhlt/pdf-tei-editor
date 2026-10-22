"""
Plugin manager for application-wide plugin lifecycle management.

This module provides a singleton manager that handles plugin discovery,
initialization, route registration, and execution.
"""

import asyncio
import logging
import os
import signal
import sys
import time
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable

from fastapi import Depends, FastAPI
from packaging.version import InvalidVersion, Version
from starlette.concurrency import run_in_threadpool

from fastapi_app.config import get_settings
from fastapi_app.lib.plugins import plugin_site
from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugins.plugin_base import PluginContext
from fastapi_app.lib.plugins.plugin_catalog import CatalogError, PluginCatalog
from fastapi_app.lib.plugins.plugin_gate import GatedStaticFiles, plugin_gate
from fastapi_app.lib.plugins.plugin_install import (
    InstallError,
    check_wheel,
    download_release,
    inspect,
    installed_entry,
    new_workdir,
    unpack,
)
from fastapi_app.lib.plugins.plugin_install_policy import (
    audit,
    install_enabled,
    is_repository_name,
    is_trusted,
    trusted_only,
)
from fastapi_app.lib.plugins.plugin_manifest import PluginManifest, incompatibility
from fastapi_app.lib.plugins.plugin_paths import (
    get_plugin_dirs,
    import_plugin_module,
    is_installed_package_dir,
    register_installed_package,
)
from fastapi_app.lib.plugins.plugin_registry import ChangePlan, PluginRecord, PluginRegistry
from fastapi_app.lib.plugins.plugin_state import (
    LEGACY_DISABLED_CONFIG_KEY,
    InstalledPlugin,
    PluginState,
    PluginStateStore,
)
from fastapi_app.lib.plugins.plugin_wheel import check_requirements, installed_distributions
from fastapi_app.lib.utils.config_utils import get_config

logger = logging.getLogger(__name__)

# Seconds between two checks of the shared plugin state (see watch_state())
STATE_CHECK_INTERVAL = 2.0

# Set by bin/start-prod: the parent process is the uvicorn supervisor, which restarts
# all worker processes one after the other on SIGHUP
WORKER_RECYCLE_ENV_VAR = "PTE_WORKER_RECYCLE"


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


class ConfirmationRequired(Exception):
    """Raised when a plugin of an untrusted owner is installed without typing the repository name."""

    def __init__(self, repository: str):
        super().__init__(f"Installing from {repository} must be confirmed")
        self.repository = repository


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
        self._state_store: PluginStateStore | None = None
        # Generation of the shared plugin state this process has applied
        self.generation = 0
        self._watch_task: asyncio.Task[None] | None = None
        # Start of this process, compared with the state's restart_required_at
        self.started = time.time()
        # Index in app.router.routes before which routes of plugins loaded later are inserted
        self._route_anchor: int | None = None
        self.catalog = PluginCatalog()

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
        3. Installed packages with a ``pte.plugins`` entry point
        """
        state = self._remove_pending_directories(self.state_store.read())
        plugin_site.activate(state.installed)
        deferred, site_dirs = self._site_records(state)
        plugin_dirs = get_plugin_dirs()
        logger.info(f"Discovering plugins from {len(plugin_dirs)} directories")
        self.registry.discover_plugins(
            plugin_dirs, builtin_dir=get_settings().plugins_code_dir, deferred=deferred, site_dirs=site_dirs
        )
        self.load_disabled()

    # ---- runtime-installed plugins (data/plugins/site) -------------------------

    @staticmethod
    def _site_record(entry: InstalledPlugin, directory: Path) -> PluginRecord:
        """Record of a runtime-installed plugin that is listed but not imported."""
        metadata: dict[str, Any] = {
            "id": entry.id,
            "name": entry.name or entry.id,
            "description": entry.description,
            "category": "",
            "version": entry.version,
            "required_roles": [],
            "dependencies": list(entry.dependencies),
        }
        return PluginRecord(
            id=entry.id, metadata=metadata, plugin=None, directory=directory, external=True, deferred=True, site=True
        )

    def _site_records(self, state: PluginState) -> tuple[dict[Path, PluginRecord], set[Path]]:
        """
        Records of the disabled runtime-installed plugins, which are not imported at startup,
        and the directories of all runtime-installed plugins.
        """
        deferred: dict[Path, PluginRecord] = {}
        site_dirs: set[Path] = set()
        for entry in state.installed:
            try:
                directory = plugin_site.package_dir(entry)
            except ValueError as e:
                logger.error(f"Installed plugin {entry.id}: {e}")
                continue
            site_dirs.add(directory.resolve())
            if entry.id in state.disabled:
                deferred[directory.resolve()] = self._site_record(entry, directory)
        return deferred, site_dirs

    def _remove_pending_directories(self, state: PluginState) -> PluginState:
        """Delete the site directories of upgraded and removed plugins once no older worker uses them."""
        if not state.pending_removal or self._older_workers(state) > 0:
            return state
        done = set(plugin_site.remove_pending(state))
        if not done:
            return state
        try:
            return self.state_store.update(lambda s: replace(s, pending_removal=s.pending_removal - done))
        except OSError as e:
            logger.error(f"Could not update the plugin state: {e}")
            return state

    def _older_workers(self, state: PluginState) -> int:
        """Number of other running workers started before the restart the state asks for."""
        if state.restart_required_at is None:
            return 0
        return sum(
            1 for b in self.state_store.heartbeats() if b.pid != os.getpid() and b.started < state.restart_required_at
        )

    def restart_pending(self, state: PluginState | None = None) -> int:
        """Number of worker processes (including this one) that still run code replaced by an upgrade or removal."""
        state = state or self.state_store.read()
        if state.restart_required_at is None:
            return 0
        return self._older_workers(state) + (1 if self.started < state.restart_required_at else 0)

    def _sync_installed(self, state: PluginState) -> None:
        """
        Apply the runtime-installed plugins of the state to this process.

        New plugins are listed (not imported); a not-imported plugin whose version changed
        is listed with the new version; removed plugins that were never imported are dropped.
        Imported plugins keep running their code until the worker restarts.
        """
        installed = {e.id: e for e in state.installed}
        for entry in state.installed:
            record = self.registry.get_record(entry.id)
            if record is not None and not (record.deferred and record.site):
                continue
            if record is not None and record.metadata.get("version") == entry.version:
                continue
            try:
                directory = plugin_site.package_dir(entry)
            except ValueError as e:
                logger.error(f"Installed plugin {entry.id}: {e}")
                continue
            if record is not None and record.directory is not None:
                self._remove_from_sys_path(record.directory.parent)
            if not plugin_site.activate((entry,)):
                if str(directory.parent) not in sys.path:
                    continue
            register_installed_package(directory, entry.package)
            new_record = self._site_record(entry, directory)
            self.registry.add_deferred(new_record)
            logger.info(f"Listed runtime-installed plugin {entry.id} {entry.version}")
        for record in self.registry.get_records():
            if record.site and record.deferred and record.id not in installed:
                if record.directory is not None:
                    self._remove_from_sys_path(record.directory.parent)
                self.registry.remove_record(record.id)

    @staticmethod
    def _remove_from_sys_path(directory: Path) -> None:
        """Remove a version directory of a plugin that was never imported from sys.path."""
        entry = str(directory)
        if entry in sys.path:
            sys.path.remove(entry)
            sys.path_importer_cache.pop(entry, None)

    def _load_deferred(self, plugin_id: str, errors: dict[str, str]) -> bool:
        """
        Import a listed runtime-installed plugin (and the listed plugins it requires) and register its routes.

        Returns:
            True if the plugin is loaded
        """
        record = self.registry.get_record(plugin_id)
        if record is None:
            return False
        if not record.deferred:
            return record.load_status == "ok"
        for dep in record.dependencies:
            dep_record = self.registry.get_record(dep)
            if dep_record is not None and dep_record.deferred:
                self._load_deferred(dep, errors)
        record = self.registry.load_deferred(plugin_id)
        if record.load_status != "ok" or record.plugin is None:
            errors[plugin_id] = record.error or "Could not be loaded"
            return False
        for dep in record.dependencies:
            dep_record = self.registry.get_record(dep)
            if dep_record is not None and dep_record.deferred:
                self._load_deferred(dep, errors)
        self.register_live_routes(plugin_id)
        logger.info(f"Loaded runtime-installed plugin {plugin_id}")
        return True

    @property
    def state_store(self) -> PluginStateStore:
        """Store of the plugin state shared by all worker processes (``data/db/plugins-state.json``)."""
        if self._state_store is None:
            self._state_store = PluginStateStore(
                get_settings().db_dir,
                legacy_disabled=lambda: list(get_config().get(LEGACY_DISABLED_CONFIG_KEY, default=[]) or []),
            )
        return self._state_store

    @state_store.setter
    def state_store(self, store: PluginStateStore) -> None:
        self._state_store = store

    def load_disabled(self) -> None:
        """Load the explicitly disabled plugin ids from the shared plugin state."""
        state = self.state_store.read()
        self.registry.set_disabled(set(state.disabled))
        self.generation = state.generation

    async def reconcile(self) -> bool:
        """
        Apply the shared plugin state if another worker process has changed it.

        Returns:
            True if a change was applied
        """
        async with self._lock:
            state = self.state_store.read()
            if state.generation == self.generation:
                return False
            errors: dict[str, str] = {}
            self._sync_installed(state)
            for record in self.registry.get_records():
                if record.deferred and record.id not in state.disabled:
                    self._load_deferred(record.id, errors)
            plan = self.registry.plan(set(state.disabled))
            self.registry.set_disabled(set(state.disabled))
            errors.update(await self._apply_plan(plan))
            self.generation = state.generation
            logger.info(
                "Applied plugin state generation %s (deactivated: %s, activated: %s)",
                state.generation,
                plan.deactivate,
                plan.activate,
            )
            for pid, message in errors.items():
                logger.error(f"Plugin {pid}: {message}")
            return True

    async def watch_state(self, interval: float = STATE_CHECK_INTERVAL) -> None:
        """
        Keep this worker in sync with the shared plugin state until cancelled.

        Checks the state file's modification time every ``interval`` seconds, applies
        changes made by other workers, and writes this worker's heartbeat.
        """
        store = self.state_store
        # The first check always reconciles: the state may have changed since discovery
        first, last_mtime = True, store.mtime()
        while True:
            try:
                mtime = store.mtime()
                if first or mtime != last_mtime:
                    first, last_mtime = False, mtime
                    await self.reconcile()
                store.write_heartbeat(self.generation, started=self.started)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f"Error while syncing the plugin state: {e}", exc_info=True)
            await asyncio.sleep(interval)

    def start_state_watcher(self) -> None:
        """Start watch_state() as a background task (called in the application lifespan)."""
        if self._watch_task is None or self._watch_task.done():
            self._watch_task = asyncio.create_task(self.watch_state(), name="plugin-state-watcher")

    async def stop_state_watcher(self) -> None:
        """Stop the background task and remove this worker's heartbeat."""
        if self._watch_task is not None:
            self._watch_task.cancel()
            try:
                await self._watch_task
            except asyncio.CancelledError:
                pass
            self._watch_task = None
        try:
            self.state_store.remove_heartbeat()
        except OSError as e:
            logger.warning(f"Could not remove plugin worker heartbeat: {e}")

    def propagation(self) -> dict[str, int]:
        """
        How far the current plugin state has reached the worker processes.

        Returns:
            {"generation": current generation, "workers": running workers,
            "pending": workers that have not applied it yet, "restart_pending": workers
            that still run code replaced by an upgrade or removal}
        """
        state = self.state_store.read()
        generation = state.generation
        beats = [b for b in self.state_store.heartbeats() if b.pid != os.getpid()]
        pending = sum(1 for b in beats if b.generation < generation)
        if self.generation < generation:
            pending += 1
        return {
            "generation": generation,
            "workers": len(beats) + 1,
            "pending": pending,
            "restart_pending": self.restart_pending(state),
        }

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
        # Routes added later go here, before the catch-all routes main.py adds next
        self._route_anchor = len(app.router.routes)

    def register_live_routes(self, plugin_id: str) -> None:
        """
        Register the routes and static files of a plugin loaded after startup.

        Starlette matches routes by iterating ``app.router.routes`` on every request, so the
        plugin's routes are inserted at the position recorded by register_plugin_routes(),
        before the catch-all routes (compat router, static mounts). The list is replaced in
        one assignment; the cached OpenAPI schema is reset.

        Args:
            plugin_id: Plugin identifier
        """
        app = self._app
        if app is None or self._route_anchor is None:
            return
        before = list(app.router.routes)
        try:
            self._try_register_plugin_routes(app, plugin_id)
            self._try_mount_plugin_static_files(app, plugin_id)
        except Exception as e:
            logger.error(f"Error registering routes for plugin {plugin_id}: {e}")
        added = app.router.routes[len(before):]
        if not added:
            return
        anchor = min(self._route_anchor, len(before))
        app.router.routes = before[:anchor] + added + before[anchor:]
        self._route_anchor = anchor + len(added)
        app.openapi_schema = None
        logger.info(f"Registered {len(added)} route(s) of plugin {plugin_id} after startup")

    def _get_plugin_directory(self, plugin_id: str) -> Path | None:
        """
        Return the directory a plugin was discovered in.

        Args:
            plugin_id: Plugin identifier

        Returns:
            Plugin directory, or None for plugins registered without discovery
        """
        record = self.registry.get_record(plugin_id)
        return record.directory if record is not None else None

    def _try_register_plugin_routes(self, app: FastAPI, plugin_id: str) -> None:
        """
        Try to load and register routes.py for a plugin.

        Args:
            app: FastAPI application instance
            plugin_id: Plugin identifier
        """
        plugin_dir = self._get_plugin_directory(plugin_id)
        if plugin_dir is None or not (plugin_dir / "routes.py").exists():
            return

        try:
            # Import as part of the plugin's package so relative imports work
            module = import_plugin_module(plugin_dir, "routes")
        except (Exception, SystemExit) as e:
            logger.error(f"Error loading routes.py for plugin {plugin_id}: {e}", exc_info=True)
            return

        if hasattr(module, "router"):
            app.include_router(module.router, dependencies=[Depends(plugin_gate(plugin_id))])
            logger.info(f"Registered custom routes for plugin: {plugin_id}")
        else:
            logger.warning(f"No 'router' found in {plugin_dir / 'routes.py'}")

    def _try_mount_plugin_static_files(self, app: FastAPI, plugin_id: str) -> None:
        """
        Try to mount static files from plugin's static directory.

        Args:
            app: FastAPI application instance
            plugin_id: Plugin identifier
        """
        plugin_dir = self._get_plugin_directory(plugin_id)
        if plugin_dir is None:
            return
        static_dir = plugin_dir / "static"
        if not static_dir.is_dir():
            return

        try:
            # Mount at /api/plugins/{plugin_id}/static/
            mount_path = f"/api/plugins/{plugin_id}/static"
            app.mount(
                mount_path,
                GatedStaticFiles(plugin_id=plugin_id, directory=str(static_dir)),
                name=f"plugin_{plugin_id}_static"
            )
            logger.info(f"Mounted static files for plugin {plugin_id} at {mount_path}")
        except Exception as e:
            logger.error(f"Error mounting static files for plugin {plugin_id}: {e}")

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
            {"changed": {id: status}, "errors": {id: message}, "reload_required": True,
            "generation": n}; the other worker processes apply generation n within a few
            seconds (see watch_state())

        Raises:
            PluginChangeError: unknown plugin (404); protected, unavailable or failed (409);
                state file write failed (500)
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
                state = self.state_store.read()
                waiting = [p for p in [plugin_id, *needed] if p in state.restart_plugins]
                if waiting and self.restart_pending(state):
                    raise PluginChangeError(
                        409, f"Apply the pending plugin changes (restart) before enabling {', '.join(waiting)}"
                    )
                # Runtime-installed plugins are imported only now
                load_errors: dict[str, str] = {}
                for pid in [*needed, plugin_id]:
                    self._load_deferred(pid, load_errors)
                if load_errors:
                    raise PluginChangeError(
                        409, "; ".join(f"Plugin {pid} could not be loaded: {msg}" for pid, msg in load_errors.items())
                    )
                # The loaded plugin's own metadata may declare further dependencies
                needed = [d for d in registry.dependencies(plugin_id, transitive=True) if d in disabled]
                if needed and not cascade:
                    raise CascadeRequired(needed, "enable")
                for pid in needed:
                    self._load_deferred(pid, load_errors)
                new_disabled = disabled - {plugin_id} - set(needed)
            else:
                new_disabled = disabled | {plugin_id}
                affected = [p for p in registry.plan(new_disabled).deactivate if p != plugin_id]
                if affected and not cascade:
                    raise CascadeRequired(affected, "disable")

            plan = registry.plan(new_disabled)
            try:
                state = self.state_store.write(new_disabled)
            except OSError as e:
                raise PluginChangeError(500, f"Could not save plugin state: {e}")
            registry.set_disabled(new_disabled)
            self.generation = state.generation

            errors = await self._apply_plan(plan)
            self._audit(
                "enable" if enabled else "disable", user, plugin=plugin_id,
                deactivated=plan.deactivate, activated=plan.activate,
            )
            touched = {plugin_id, *plan.deactivate, *plan.activate}
            return {
                "changed": {p: registry.status(p)[0] for p in touched},
                "errors": errors,
                "reload_required": True,
                "generation": state.generation,
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

    # ---- runtime install, upgrade and removal ----------------------------------

    def _audit(self, action: str, user: dict[str, Any] | None = None, **fields: Any) -> None:
        """Record a plugin change in the audit log next to the plugin state file."""
        audit(action, user, log_dir=self.state_store.db_dir, **fields)

    @staticmethod
    def _require_install_enabled() -> None:
        if not install_enabled():
            raise PluginChangeError(403, "Installing plugins at runtime is disabled on this server (PTE_PLUGIN_INSTALL)")

    async def available_plugins(self, refresh: bool = False, user: dict[str, Any] | None = None) -> dict[str, Any]:
        """
        The plugins that can be installed from the plugin repositories.

        Args:
            refresh: Read the repositories again instead of using the cached catalog
            user: Acting user (for the audit log)

        Returns:
            {"plugins": [...], "errors": {source: message}, "fetched_at": time}

        Raises:
            PluginChangeError: Runtime install is disabled (403)
        """
        self._require_install_enabled()
        previous = self.catalog.fetched_at
        catalog = await run_in_threadpool(self.catalog.get, refresh)
        if catalog.fetched_at != previous:
            self._audit("discover", user, repositories=sorted({e.repository for e in catalog.entries}), errors=catalog.errors)
        state = self.state_store.read()
        available = installed_distributions()
        plugins: list[dict[str, Any]] = []
        for entry in catalog.entries:
            record = self.registry.get_record(entry.id)
            installed = state.get_installed(entry.id)
            latest = entry.latest
            reason = incompatibility(
                PluginManifest(pte=entry.engines.get("pte"), plugin_api=entry.engines.get("pte-plugin-api"))
            )
            current_version: str | None = None
            if installed is not None:
                current_version = installed.version
            elif record is not None:
                current_version = (record.manifest.version if record.manifest else None) or str(
                    record.metadata.get("version", "")
                ) or None
            unmet = check_requirements(entry.dependencies, available)
            installable = latest is not None and reason is None and not unmet and self._replaceable(record) is None
            plugins.append({
                "id": entry.id,
                "repository": entry.repository,
                "description": entry.description,
                "index_version": entry.version,
                "latest_version": latest.version if latest else None,
                "latest_tag": latest.tag if latest else None,
                "versions": [r.version for r in entry.releases],
                "installed_version": current_version,
                "installed_source": (
                    None if record is None else "site" if record.site else "external" if record.external else "builtin"
                ),
                "requires": entry.requires,
                "unmet_requirements": unmet,
                "trusted": entry.trusted,
                "compatible": reason is None,
                "incompatible_reason": reason or self._replaceable(record),
                "installable": installable,
                "update_available": bool(
                    installable and latest and current_version and _newer(latest.version, current_version)
                ),
            })
        return {"plugins": plugins, "errors": catalog.errors, "fetched_at": catalog.fetched_at}

    @staticmethod
    def _replaceable(record: PluginRecord | None) -> str | None:
        """Why an existing plugin cannot be replaced by a runtime install, or None if it can."""
        if record is None or record.site:
            return None
        if not record.external:
            return "Built-in plugin"
        if record.directory is not None and is_installed_package_dir(record.directory):
            return None
        return "Loaded from FASTAPI_PLUGIN_PATHS"

    async def install_plugin(
        self,
        repository: str,
        plugin_id: str,
        version: str | None = None,
        confirm: str | None = None,
        user: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Install or upgrade a plugin from a GitHub release of a plugin repository.

        Args:
            repository: ``owner/repo`` of a plugin repository listed in the catalog
            plugin_id: Plugin id in the repository's index
            version: Release version (default: the latest release)
            confirm: The repository name, typed by the admin; required for untrusted owners
            user: Acting user

        Returns:
            See install_wheel()

        Raises:
            PluginChangeError: Install disabled (403), not found (404), not installable (409, 422), download failed (502)
            ConfirmationRequired: Untrusted repository without confirmation
            InstallError: The wheel cannot be installed (with unmet requirements)
        """
        self._require_install_enabled()
        if not is_repository_name(repository):
            raise PluginChangeError(400, f"Invalid repository name: {repository}")
        trusted = is_trusted(repository)
        if not trusted and trusted_only():
            raise PluginChangeError(403, f"Only plugins of trusted owners can be installed; {repository} is not trusted")
        if not trusted and confirm != repository:
            raise ConfirmationRequired(repository)
        try:
            entry = await run_in_threadpool(self.catalog.find, repository, plugin_id)
        except CatalogError as e:
            raise PluginChangeError(404, str(e))
        release = entry.release(version) if version else entry.latest
        if release is None:
            wanted = f"release {version}" if version else "release"
            raise PluginChangeError(404, f"No installable {wanted} of {plugin_id} in {repository}")
        site_dir = plugin_site.get_site_dir()
        with new_workdir(site_dir) as workdir:
            download = await run_in_threadpool(download_release, self.catalog.client, entry, release, Path(workdir))
            return await self.install_wheel(
                download.path, download.sha256, repository, release.tag, trusted, user=user, expected_id=plugin_id
            )

    async def install_wheel(
        self,
        wheel: Path,
        sha256: str,
        repository: str,
        tag: str,
        trusted: bool,
        user: dict[str, Any] | None = None,
        expected_id: str | None = None,
    ) -> dict[str, Any]:
        """
        Install a verified plugin wheel into the site directory and record it in the plugin state.

        A new plugin is installed disabled and imported when it is enabled. An upgrade of a
        plugin that is imported in this process takes effect after a restart (restart_workers()).

        Returns:
            {"plugin": id, "version": v, "action": "install" | "upgrade", "restart_required": bool,
            "generation": n}

        Raises:
            InstallError: Not installable here (incompatible, unmet requirements, already installed)
        """
        info = inspect(wheel)
        async with self._lock:
            state = self.state_store.read()
            record = self.registry.get_record(info.plugin_id)
            previous = state.get_installed(info.plugin_id)
            reason = self._replaceable(record)
            if reason:
                raise InstallError(409, f"Plugin {info.plugin_id} cannot be replaced: {reason}")
            if previous is not None and previous.version == info.version:
                raise InstallError(409, f"Plugin {info.plugin_id} {info.version} is installed already")
            unmet = check_wheel(info, expected_id)
            if unmet:
                raise InstallError(
                    409,
                    f"Plugin {info.plugin_id} needs packages that are not installed; install it with uv sync instead",
                    unmet,
                )
            site_dir = plugin_site.get_site_dir()
            relative = await run_in_threadpool(unpack, wheel, info, site_dir)
            new_entry = installed_entry(
                info, relative, sha256, repository, tag, trusted, (user or {}).get("username", "cli")
            )
            upgrade = record is not None or previous is not None
            restart = record is not None and not record.deferred
            now = time.time()

            def change(current: PluginState) -> PluginState:
                installed = tuple(e for e in current.installed if e.id != new_entry.id) + (new_entry,)
                pending = set(current.pending_removal)
                if previous is not None:
                    pending.add(previous.path)
                disabled = current.disabled if upgrade else current.disabled | {new_entry.id}
                result = replace(current, installed=installed, pending_removal=frozenset(pending), disabled=disabled)
                if restart:
                    plugins = current.restart_plugins if self.restart_pending(current) else frozenset()
                    result = replace(result, restart_required_at=now, restart_plugins=plugins | {new_entry.id})
                return result

            try:
                state = self.state_store.update(change)
            except OSError as e:
                raise PluginChangeError(500, f"Could not save plugin state: {e}")
            self.registry.set_disabled(set(state.disabled))
            self.generation = state.generation
            self._sync_installed(state)
        action = "upgrade" if upgrade else "install"
        self._audit(
            action, user, plugin=info.plugin_id, version=info.version, repository=repository, tag=tag,
            sha256=sha256, trusted=trusted, restart_required=restart,
        )
        return {
            "plugin": info.plugin_id,
            "version": info.version,
            "action": action,
            "restart_required": restart,
            "generation": state.generation,
        }

    async def remove_plugin(self, plugin_id: str, cascade: bool = False, user: dict[str, Any] | None = None) -> dict[str, Any]:
        """
        Remove a runtime-installed plugin: disable it, and delete its files at the next start.

        Raises:
            PluginChangeError: Not installed at runtime (404)
            CascadeRequired: Disabling it deactivates other plugins and cascade is False
        """
        state = self.state_store.read()
        entry = state.get_installed(plugin_id)
        if entry is None:
            raise PluginChangeError(404, f"Plugin {plugin_id} was not installed in the plugin manager and cannot be removed here")
        record = self.registry.get_record(plugin_id)
        if record is not None and plugin_id not in self.registry.disabled and record.load_status == "ok":
            await self.set_plugin_enabled(plugin_id, False, cascade=cascade, user=user)
        async with self._lock:
            record = self.registry.get_record(plugin_id)
            restart = record is not None and record.plugin is not None
            now = time.time()

            def change(current: PluginState) -> PluginState:
                result = replace(
                    current,
                    installed=tuple(e for e in current.installed if e.id != plugin_id),
                    pending_removal=current.pending_removal | {entry.path},
                    disabled=current.disabled | {plugin_id},
                )
                if restart:
                    plugins = current.restart_plugins if self.restart_pending(current) else frozenset()
                    result = replace(result, restart_required_at=now, restart_plugins=plugins | {plugin_id})
                return result

            try:
                state = self.state_store.update(change)
            except OSError as e:
                raise PluginChangeError(500, f"Could not save plugin state: {e}")
            self.registry.set_disabled(set(state.disabled))
            self.generation = state.generation
            self._sync_installed(state)
        self._audit("remove", user, plugin=plugin_id, version=entry.version, repository=entry.repository, tag=entry.tag)
        return {"plugin": plugin_id, "version": entry.version, "action": "remove", "restart_required": restart, "generation": state.generation}

    def restart_workers(self, user: dict[str, Any] | None = None) -> None:
        """
        Restart all worker processes, one after the other, to apply upgrades and removals.

        Sends SIGHUP to the uvicorn supervisor (the parent process) shortly after returning,
        so the response can still be sent.

        Raises:
            PluginChangeError: The server was not started by bin/start-prod (409)
        """
        if os.getenv(WORKER_RECYCLE_ENV_VAR) != "1" or not hasattr(signal, "SIGHUP"):
            raise PluginChangeError(409, "This server cannot restart its workers itself; restart the server to apply the plugin changes")
        supervisor = os.getppid()
        self._audit("restart", user, supervisor=supervisor)
        self._schedule(0.5, lambda: os.kill(supervisor, signal.SIGHUP))

    @staticmethod
    def _schedule(delay: float, callback: Callable[[], None]) -> None:
        """Run a callback after a delay on the running event loop."""
        asyncio.get_running_loop().call_later(delay, callback)


def _newer(candidate: str, current: str) -> bool:
    """Whether version candidate is newer than current (PEP 440, falling back to inequality)."""
    try:
        return Version(candidate) > Version(current)
    except InvalidVersion:
        return candidate != current
