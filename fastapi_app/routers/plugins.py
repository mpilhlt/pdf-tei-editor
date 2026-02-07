"""
API routes for backend plugin system.

Provides endpoints for:
- Listing available plugins (filtered by user roles)
- Executing plugin endpoints
- Serving frontend extension JavaScript bundle
"""

import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from fastapi_app.lib.dependencies import get_current_user, get_session_id_from_request
from fastapi_app.lib.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugin_manager import PluginManager
from fastapi_app.lib.plugin_tools import validate_javascript_content

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
        category: Optional category filter (e.g., "document")
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
    exec_request: ExecuteRequest,
    request: Request,
    current_user: dict | None = Depends(get_current_user),
) -> ExecuteResponse:
    """
    Execute a plugin endpoint.

    Args:
        plugin_id: Plugin identifier
        exec_request: Execution request with endpoint and params
        request: FastAPI request object (for session_id extraction)
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

    # Extract session_id and add to params
    session_id = get_session_id_from_request(request)
    params_with_session = {**exec_request.params, "_session_id": session_id}

    try:
        result = await manager.execute_plugin(
            plugin_id=plugin_id,
            endpoint=exec_request.endpoint,
            params=params_with_session,
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


def transform_extension_to_iife(content: str, filename: str, plugin_id: str) -> str:
    """
    Transform ES module extension to self-registering IIFE format.

    Input (ES module):
        export const name = "...";
        export const deps = [...];
        export function install(state, sandbox) { ... }
        export function onStateUpdate(changedKeys, state, sandbox) { ... }

    Output (self-registering IIFE):
        (function() {
          const name = "...";
          const deps = [...];
          function install(state, sandbox) { ... }
          function onStateUpdate(changedKeys, state, sandbox) { ... }
          window.registerFrontendExtension({
            name, deps, install, onStateUpdate,
            pluginId: "..."
          });
        })();
    """
    # Remove import statements
    content = re.sub(r"^import\s+.*?;?\s*$", "", content, flags=re.MULTILINE)

    # Remove 'export' keywords
    content = re.sub(r"^export\s+const\s+", "const ", content, flags=re.MULTILINE)
    content = re.sub(r"^export\s+function\s+", "function ", content, flags=re.MULTILINE)
    content = re.sub(r"^export\s+async\s+function\s+", "async function ", content, flags=re.MULTILINE)
    content = re.sub(r"^export\s+default\s+.*?;\s*$", "", content, flags=re.MULTILINE)

    # Extract exported names for registration object
    # Find const declarations
    const_names = re.findall(r"^const\s+(\w+)\s*=", content, flags=re.MULTILINE)
    # Find function declarations
    func_names = re.findall(r"^(?:async\s+)?function\s+(\w+)\s*\(", content, flags=re.MULTILINE)

    all_exports = const_names + func_names
    exports_str = ", ".join(all_exports)

    return f"""// Frontend extension from plugin: {plugin_id} ({filename})
(function() {{
{content.strip()}
window.registerFrontendExtension({{
  {exports_str},
  pluginId: "{plugin_id}"
}});
}})();"""


@router.get("/sandbox-client.js", response_class=PlainTextResponse)
async def get_sandbox_client_script():
    """
    Return the auto-generated sandbox client JavaScript.

    Static plugin HTML pages can load this via:
        <script src="/api/v1/plugins/sandbox-client.js"></script>
    """
    from fastapi_app.lib.plugin_tools import generate_sandbox_client_script

    script = generate_sandbox_client_script()
    return PlainTextResponse(content=script, media_type="application/javascript")


@router.get("/extensions.js", response_class=PlainTextResponse)
async def get_extensions_bundle():
    """
    Return concatenated JavaScript of all registered frontend extensions.
    Each extension self-registers via window.registerFrontendExtension().
    """
    bundle_parts = []

    registry = FrontendExtensionRegistry.get_instance()

    for js_file, plugin_id in registry.get_extension_files():
        try:
            content = js_file.read_text()

            # Validate content for dangerous patterns
            is_valid, warnings = validate_javascript_content(content, js_file.name)
            if not is_valid:
                for warning in warnings:
                    logger.warning(f"Extension validation: {warning}")
                bundle_parts.append(
                    f"// Skipped {js_file.name} from {plugin_id}: "
                    f"validation failed ({len(warnings)} warning(s))\n"
                )
                continue

            transformed = transform_extension_to_iife(content, js_file.name, plugin_id)
            bundle_parts.append(transformed)
        except Exception as e:
            bundle_parts.append(
                f"// Error loading {js_file.name} from {plugin_id}: {e}\n"
            )

    bundle = "\n\n".join(bundle_parts)

    return PlainTextResponse(content=bundle, media_type="application/javascript")
