"""
API routes for backend plugin system.

Provides endpoints for:
- Listing available plugins (filtered by user roles)
- Executing plugin endpoints
"""

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from fastapi_app.lib.dependencies import get_current_user
from fastapi_app.lib.plugin_manager import PluginManager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/plugins", tags=["plugins"])


class ExecuteRequest(BaseModel):
    """Request body for plugin execution."""

    endpoint: str
    params: dict[str, Any]


class PluginListResponse(BaseModel):
    """Response for plugin listing."""

    plugins: list[dict[str, Any]]


class ExecuteResponse(BaseModel):
    """Response for plugin execution."""

    success: bool
    result: Any


@router.get("", response_model=PluginListResponse)
async def list_plugins(
    category: str | None = None,
    current_user: dict | None = Depends(get_current_user),
) -> PluginListResponse:
    """
    List available plugins filtered by user roles and optional category.

    Args:
        category: Optional category filter (e.g., "analyzer")
        current_user: Current authenticated user (optional)

    Returns:
        List of plugin metadata dicts
    """
    manager = PluginManager.get_instance()

    # Get user roles (empty list if not authenticated)
    user_roles = current_user.get("roles", []) if current_user else []

    plugins = manager.get_plugins(category=category, user_roles=user_roles)

    return PluginListResponse(plugins=plugins)


@router.post("/{plugin_id}/execute", response_model=ExecuteResponse)
async def execute_plugin(
    plugin_id: str,
    request: ExecuteRequest,
    current_user: dict | None = Depends(get_current_user),
) -> ExecuteResponse:
    """
    Execute a plugin endpoint.

    Args:
        plugin_id: Plugin identifier
        request: Execution request with endpoint and params
        current_user: Current authenticated user (optional)

    Returns:
        Execution result

    Raises:
        HTTPException: If plugin/endpoint not found or execution fails
    """
    manager = PluginManager.get_instance()

    # Check if user has access to this plugin
    user_roles = current_user.get("roles", []) if current_user else []
    accessible_plugins = manager.get_plugins(user_roles=user_roles)

    if not any(p["id"] == plugin_id for p in accessible_plugins):
        raise HTTPException(status_code=404, detail=f"Plugin not found: {plugin_id}")

    try:
        result = await manager.execute_plugin(
            plugin_id=plugin_id,
            endpoint=request.endpoint,
            params=request.params,
            user=current_user,
        )

        return ExecuteResponse(success=True, result=result)

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Error executing plugin {plugin_id}.{request.endpoint}: {e}")
        raise HTTPException(
            status_code=500, detail=f"Plugin execution failed: {str(e)}"
        )
