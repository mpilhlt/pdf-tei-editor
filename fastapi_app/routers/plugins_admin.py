"""
Admin API for managing backend plugins (enable/disable, info).

All endpoints require the admin role.
"""

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from fastapi_app.lib.core.dependencies import require_admin_user
from fastapi_app.lib.plugins.plugin_info import build_plugin_info
from fastapi_app.lib.plugins.plugin_manager import CascadeRequired, PluginChangeError, PluginManager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/plugins/admin", tags=["plugins-admin"])


class PluginAdminInfo(BaseModel):
    """Plugin information for the plugin manager dialog."""

    id: str
    name: str
    version: str
    description: str
    category: str
    required_roles: list[str]
    status: str
    status_reason: str | None
    enabled: bool
    protected: bool
    dependencies: list[str]
    dependents: list[str]
    source: str
    readme_url: str | None
    has_routes: bool
    has_frontend_extension: bool
    menu_endpoints: int


class PluginAdminListResponse(BaseModel):
    """List of all discovered plugins."""

    plugins: list[PluginAdminInfo]


class ChangeRequest(BaseModel):
    """Body for enable/disable; cascade confirms the effect on other plugins."""

    cascade: bool = False


class ChangeResult(BaseModel):
    """Result of an enable/disable call."""

    changed: dict[str, str]
    errors: dict[str, str]
    reload_required: bool


class CascadeRequiredResponse(BaseModel):
    """409 body: the change affects other plugins and needs confirmation."""

    detail: str
    affected: list[str]
    direction: str


@router.get("", response_model=PluginAdminListResponse)
async def plugins_admin_list(
    _admin: dict[str, Any] = Depends(require_admin_user),
) -> PluginAdminListResponse:
    """List all discovered plugins with status, dependencies and README link."""
    registry = PluginManager.get_instance().registry
    records = sorted(registry.get_records(), key=lambda r: str(r.metadata.get("name", r.id)).lower())
    return PluginAdminListResponse(
        plugins=[PluginAdminInfo(**build_plugin_info(registry, r)) for r in records]
    )


async def _change(
    plugin_id: str, enabled: bool, body: ChangeRequest, admin: dict[str, Any]
) -> ChangeResult | JSONResponse:
    manager = PluginManager.get_instance()
    try:
        result = await manager.set_plugin_enabled(plugin_id, enabled, cascade=body.cascade, user=admin)
    except CascadeRequired as e:
        return JSONResponse(
            status_code=409,
            content={"detail": "cascade_required", "affected": e.affected, "direction": e.direction},
        )
    except PluginChangeError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    return ChangeResult(**result)


@router.post(
    "/{plugin_id}/enable",
    response_model=ChangeResult,
    responses={409: {"model": CascadeRequiredResponse}},
)
async def plugins_admin_enable(
    plugin_id: str,
    body: ChangeRequest,
    admin: dict[str, Any] = Depends(require_admin_user),
) -> ChangeResult | JSONResponse:
    """Enable a plugin (and, with cascade, the disabled plugins it requires)."""
    return await _change(plugin_id, True, body, admin)


@router.post(
    "/{plugin_id}/disable",
    response_model=ChangeResult,
    responses={409: {"model": CascadeRequiredResponse}},
)
async def plugins_admin_disable(
    plugin_id: str,
    body: ChangeRequest,
    admin: dict[str, Any] = Depends(require_admin_user),
) -> ChangeResult | JSONResponse:
    """Disable a plugin (and, with cascade, deactivate the plugins that depend on it)."""
    return await _change(plugin_id, False, body, admin)
