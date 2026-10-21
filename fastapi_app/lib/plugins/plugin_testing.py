"""
Test helpers for plugins, shared by core tests and plugin repositories.

``check_lifecycle_conformance()`` runs ``initialize -> cleanup -> initialize -> cleanup``
for every plugin found in the given directories, the same check core runs for its
built-in plugins (see docs/code-assistant/backend-plugins.md, "initialize() and
cleanup() must be re-entrant and symmetric").
"""

from pathlib import Path

from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugins.plugin_base import PluginContext
from fastapi_app.lib.plugins.plugin_registry import PluginRegistry


async def check_lifecycle_conformance(
    plugin_dirs: list[Path], builtin_dir: Path | None = None
) -> list[str]:
    """
    Run initialize -> cleanup -> initialize -> cleanup for every loadable plugin.

    Plugins whose first ``initialize()`` fails are skipped, because they need an
    environment (server, API key) that a unit test does not provide. Exceptions in
    the following calls propagate to the caller.

    Args:
        plugin_dirs: Directories to discover plugins in (see PluginRegistry.discover_plugins)
        builtin_dir: Directory of built-in plugins, if it is among ``plugin_dirs``

    Returns:
        Ids of the plugins that were checked
    """
    registry = PluginRegistry()
    registry.discover_plugins(plugin_dirs, builtin_dir=builtin_dir)
    FrontendExtensionRegistry.reset_instance()
    checked: list[str] = []
    try:
        for record in registry.get_records():
            if record.load_status != "ok" or record.plugin is None:
                continue
            ctx = PluginContext(app=None, plugin_id=record.id, registry=registry)
            try:
                await record.plugin.initialize(ctx)
            except Exception:
                continue
            await record.plugin.cleanup()
            await record.plugin.initialize(ctx)
            await record.plugin.cleanup()
            checked.append(record.id)
    finally:
        FrontendExtensionRegistry.reset_instance()
    return checked
