"""
Admin API for managing backend plugins (enable/disable, info, runtime install).

All endpoints require the admin role. Discovering and installing plugins additionally
requires the operator to set PTE_PLUGIN_INSTALL=1 (see plugin_install_policy).
"""

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from fastapi_app.lib.core.dependencies import require_admin_user
from fastapi_app.lib.core.worker_recycle import can_recycle_workers
from fastapi_app.lib.plugins.plugin_info import build_plugin_info
from fastapi_app.lib.plugins.plugin_install import InstallError
from fastapi_app.lib.plugins.plugin_install_policy import install_enabled, trusted_only, trusted_owners
from fastapi_app.lib.plugins.plugin_manager import (
    CascadeRequired,
    ConfirmationRequired,
    PluginChangeError,
    PluginManager,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/plugins/admin", tags=["plugins-admin"])


class PluginAdminInfo(BaseModel):
    """Plugin information for the plugin manager dialog."""

    id: str
    name: str
    version: str
    requires_pte: str | None
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
    installed_version: str | None
    installed_from: str | None
    removable: bool
    restart_pending: bool
    readme_url: str | None
    has_routes: bool
    has_frontend_extension: bool
    menu_endpoints: int


class PropagationInfo(BaseModel):
    """How far the current plugin state has reached the server's worker processes."""

    generation: int
    workers: int
    pending: int
    restart_pending: int


class PluginAdminListResponse(BaseModel):
    """List of all discovered plugins."""

    plugins: list[PluginAdminInfo]
    propagation: PropagationInfo
    install_enabled: bool
    restart_supported: bool


class ChangeRequest(BaseModel):
    """Body for enable/disable; cascade confirms the effect on other plugins."""

    cascade: bool = False


class ChangeResult(BaseModel):
    """Result of an enable/disable call."""

    changed: dict[str, str]
    errors: dict[str, str]
    reload_required: bool
    generation: int


class CascadeRequiredResponse(BaseModel):
    """409 body: the change affects other plugins and needs confirmation."""

    detail: str
    affected: list[str]
    direction: str


class AvailablePlugin(BaseModel):
    """A plugin in a plugin repository that can be installed or upgraded."""

    id: str
    repository: str
    description: str
    index_version: str
    latest_version: str | None
    latest_tag: str | None
    versions: list[str]
    installed_version: str | None
    installed_source: str | None
    requires: list[str]
    unmet_requirements: list[str]
    trusted: bool
    compatible: bool
    incompatible_reason: str | None
    installable: bool
    update_available: bool


class AvailablePluginsResponse(BaseModel):
    """Plugins available in the plugin repositories."""

    plugins: list[AvailablePlugin]
    errors: dict[str, str]
    fetched_at: float
    trusted_owners: list[str]
    trusted_only: bool


class InstallRequest(BaseModel):
    """Body for installing a plugin from a release."""

    repository: str
    id: str
    version: str | None = None
    confirm: str | None = None


class InstallResult(BaseModel):
    """Result of an install, upgrade or removal."""

    plugin: str
    version: str
    action: str
    restart_required: bool
    generation: int


class InstallErrorDetail(BaseModel):
    """Structured detail of a refused install: code "not_installable", "unmet_requirements" or "confirmation_required"."""

    code: str
    message: str
    unmet: list[str] = []
    repository: str | None = None


class InstallErrorResponse(BaseModel):
    """409/422 body of a refused install."""

    detail: InstallErrorDetail


class RestartResult(BaseModel):
    """Result of a worker restart request."""

    restarting: bool


@router.get("", response_model=PluginAdminListResponse)
async def plugins_admin_list(
    _admin: dict[str, Any] = Depends(require_admin_user),
) -> PluginAdminListResponse:
    """List all discovered plugins with status, dependencies and README link, and the propagation of the last change."""
    manager = PluginManager.get_instance()
    registry = manager.registry
    state = manager.state_store.read()
    waiting = state.restart_plugins if manager.restart_pending(state) else frozenset()
    records = sorted(registry.get_records(), key=lambda r: str(r.metadata.get("name", r.id)).lower())
    return PluginAdminListResponse(
        plugins=[
            PluginAdminInfo(**build_plugin_info(registry, r, state.get_installed(r.id), r.id in waiting))
            for r in records
        ],
        propagation=PropagationInfo(**manager.propagation()),
        install_enabled=install_enabled(),
        restart_supported=can_recycle_workers(),
    )


@router.get("/available", response_model=AvailablePluginsResponse)
async def plugins_admin_available(
    refresh: bool = False,
    admin: dict[str, Any] = Depends(require_admin_user),
) -> AvailablePluginsResponse:
    """List the plugins that can be installed from the plugin repositories (cached for an hour unless refresh is set)."""
    try:
        result = await PluginManager.get_instance().available_plugins(refresh=refresh, user=admin)
    except PluginChangeError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    return AvailablePluginsResponse(
        plugins=[AvailablePlugin(**p) for p in result["plugins"]],
        errors=result["errors"],
        fetched_at=result["fetched_at"],
        trusted_owners=trusted_owners(),
        trusted_only=trusted_only(),
    )


@router.post(
    "/install",
    response_model=InstallResult,
    responses={409: {"model": InstallErrorResponse}, 422: {"model": InstallErrorResponse}},
)
async def plugins_admin_install(
    body: InstallRequest,
    admin: dict[str, Any] = Depends(require_admin_user),
) -> InstallResult | JSONResponse:
    """
    Install or upgrade a plugin from a release of a plugin repository.

    A new plugin is installed disabled. Plugins of untrusted owners need ``confirm`` set to the
    repository name (409 with code ``confirmation_required`` otherwise).
    """
    try:
        result = await PluginManager.get_instance().install_plugin(
            body.repository, body.id, version=body.version, confirm=body.confirm, user=admin
        )
    except ConfirmationRequired as e:
        detail = InstallErrorDetail(
            code="confirmation_required",
            message=f"{e.repository} is not a trusted plugin source; type its name to confirm the installation",
            repository=e.repository,
        )
        return JSONResponse(status_code=409, content={"detail": detail.model_dump()})
    except InstallError as e:
        code = "unmet_requirements" if e.unmet else "not_installable"
        detail = InstallErrorDetail(code=code, message=e.detail, unmet=e.unmet)
        return JSONResponse(status_code=e.status_code, content={"detail": detail.model_dump()})
    except PluginChangeError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    return InstallResult(**result)


@router.post(
    "/{plugin_id}/remove",
    response_model=InstallResult,
    responses={409: {"model": CascadeRequiredResponse}},
)
async def plugins_admin_remove(
    plugin_id: str,
    body: ChangeRequest,
    admin: dict[str, Any] = Depends(require_admin_user),
) -> InstallResult | JSONResponse:
    """Remove a plugin installed in the plugin manager; its files are deleted at the next restart."""
    try:
        result = await PluginManager.get_instance().remove_plugin(plugin_id, cascade=body.cascade, user=admin)
    except CascadeRequired as e:
        return JSONResponse(
            status_code=409,
            content={"detail": "cascade_required", "affected": e.affected, "direction": e.direction},
        )
    except PluginChangeError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    return InstallResult(**result)


@router.post("/restart", response_model=RestartResult)
async def plugins_admin_restart(
    admin: dict[str, Any] = Depends(require_admin_user),
) -> RestartResult:
    """Restart the server's worker processes one after the other, to apply plugin upgrades and removals."""
    try:
        PluginManager.get_instance().restart_workers(user=admin)
    except PluginChangeError as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)
    return RestartResult(restarting=True)


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
