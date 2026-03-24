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

from fastapi_app.lib.core.dependencies import get_current_user, get_session_id_from_request
from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugins.plugin_manager import PluginManager
from fastapi_app.lib.plugins.plugin_tools import validate_javascript_content

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
        logger.error(f"Error executing plugin {plugin_id}.{exec_request.endpoint}: {e}")
        raise HTTPException(
            status_code=500, detail=f"Plugin execution failed: {str(e)}"
        )


def transform_extension_to_iife(content: str, filename: str, plugin_id: str) -> str:
    """
    Transform a class-based ES module extension to a self-registering IIFE.

    Input (ES module with a class extending FrontendExtensionPlugin):
        export default class MyExtension extends FrontendExtensionPlugin {
          constructor(context) {
            super(context, { name: 'my-extension', deps: ['tools'] });
          }
          async install(state) { ... }
          async onXmlChange(newXml) { ... }
        }

    Output (self-registering IIFE):
        // Frontend extension from plugin: my_plugin (my-extension.js)
        (function() {
          class MyExtension extends window.FrontendExtensionPlugin {
            constructor(context) {
              super(context, { name: 'my-extension', deps: ['tools'] });
            }
            async install(state) { ... }
            async onXmlChange(newXml) { ... }
          }
          window.registerFrontendExtension(MyExtension, "my_plugin");
        })();
    """
    # Strip block and line comments (includes JSDoc @import annotations)
    content = re.sub(r"/\*.*?\*/", "", content, flags=re.DOTALL)
    content = re.sub(r"^\s*//[^\n]*", "", content, flags=re.MULTILINE)

    # Remove import statements
    content = re.sub(r"^import\s+.*?;?\s*$", "", content, flags=re.MULTILINE)

    # Detect class-based extension
    class_match = re.search(
        r"export\s+default\s+class\s+(\w+)\s+extends\s+FrontendExtensionPlugin",
        content
    )
    if not class_match:
        raise ValueError(
            f"{filename}: not a valid class-based extension "
            f"(expected 'export default class <Name> extends FrontendExtensionPlugin')"
        )

    class_name = class_match.group(1)

    # Strip 'export default' before the class declaration
    content = re.sub(r"export\s+default\s+(?=class\s)", "", content)

    # Replace local 'extends FrontendExtensionPlugin' with the global reference
    content = content.replace(
        "extends FrontendExtensionPlugin",
        "extends window.FrontendExtensionPlugin"
    )

    return f"""// Frontend extension from plugin: {plugin_id} ({filename})
(function() {{
{content.strip()}
window.registerFrontendExtension({class_name}, "{plugin_id}");
}})();"""


@router.get("/sandbox-client.js", response_class=PlainTextResponse)
async def get_sandbox_client_script():
    """
    Return the auto-generated sandbox client JavaScript.

    Static plugin HTML pages can load this via:
        <script src="/api/v1/plugins/sandbox-client.js"></script>
    """
    from fastapi_app.lib.plugins.plugin_tools import generate_sandbox_client_script

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

    return PlainTextResponse(
        content=bundle,
        media_type="application/javascript",
        headers={"Cache-Control": "no-store"},
    )
