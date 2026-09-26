"""
Request-time gating of plugin routes and static files.

Plugins stay mounted for the lifetime of the process; these helpers respond with 404
while a plugin is not active, so enabling/disabling needs no restart.
"""

from collections.abc import Callable
from typing import Any

from fastapi import HTTPException
from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope


def _ensure_active(plugin_id: str) -> None:
    """Raise 404 unless the plugin is active."""
    from fastapi_app.lib.plugins.plugin_manager import PluginManager  # avoid circular import

    if not PluginManager.get_instance().registry.is_active(plugin_id):
        raise HTTPException(status_code=404, detail=f"Plugin not found: {plugin_id}")


def plugin_gate(plugin_id: str) -> Callable[[], None]:
    """
    Create a FastAPI dependency that raises 404 while the plugin is not active.

    Args:
        plugin_id: Plugin identifier

    Returns:
        Dependency callable for use in `include_router(..., dependencies=[Depends(...)])`
    """

    def check() -> None:
        _ensure_active(plugin_id)

    return check


class GatedStaticFiles(StaticFiles):
    """StaticFiles that respond 404 while their plugin is not active."""

    def __init__(self, plugin_id: str, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._plugin_id = plugin_id

    async def get_response(self, path: str, scope: Scope) -> Response:
        """Serve the file only if the owning plugin is active."""
        _ensure_active(self._plugin_id)
        return await super().get_response(path, scope)
