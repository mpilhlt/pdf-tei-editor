"""
User manual API: the pages that plugins contribute to the manual (see `fastapi_app/lib/plugins/plugin_manual.py`
and docs/code-assistant/backend-plugins.md#manual-pages).
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..lib.core.dependencies import get_current_user
from ..lib.plugins.plugin_manager import PluginManager
from ..lib.plugins.plugin_manual import ManualFileNotFound, list_contributions, resolve_manual_file
from ..lib.plugins.plugin_registry import PluginRegistry

router = APIRouter(prefix="/manual", tags=["manual"])


class ManualContributionItem(BaseModel):
    """A page a plugin contributes to a slot of the user manual."""

    plugin_id: str = Field(description="Id of the contributing plugin")
    plugin_name: str = Field(description="Name of the contributing plugin")
    plugin_version: str = Field(description="Version of the contributing plugin")
    id: str = Field(description="Id of the page, unique within the plugin")
    slot: str = Field(description="Manual slot the page is listed in, e.g. 'tutorials'")
    title: str = Field(description="Link text")
    description: str = Field(description="One sentence shown after the link")
    files: dict[str, str] = Field(description="Markdown file per language code, relative to the plugin directory; fetch it from /api/v1/manual/plugins/{plugin_id}/{file}")
    anchors: dict[str, str] = Field(default_factory=dict, description="Heading anchor per language code, for the files the page opens at a heading of")
    order: int = Field(description="Sort key within the slot")
    active: bool = Field(description="False if the plugin or one of the plugins the page requires is not active (only listed for administrators)")


class ManualContributionsResponse(BaseModel):
    """The manual pages contributed by plugins, sorted by slot, order and title."""

    contributions: list[ManualContributionItem]


def get_plugin_registry() -> PluginRegistry:
    """The plugin registry (dependency, so tests can replace it)."""
    return PluginManager.get_instance().registry


@router.get("/contributions", response_model=ManualContributionsResponse)
def manual_contributions(
    current_user: dict[str, Any] | None = Depends(get_current_user),
    registry: PluginRegistry = Depends(get_plugin_registry),
) -> ManualContributionsResponse:
    """The pages plugins contribute to the user manual that the current user can see.

    Pages of active plugins whose required plugins are active and whose roles match the user; administrators also get
    the pages of plugins that are not active, with `active: false`. Without a session, only pages without role
    restriction are listed.
    """
    return ManualContributionsResponse(contributions=[
        ManualContributionItem(
            plugin_id=c.plugin_id,
            plugin_name=c.plugin_name,
            plugin_version=c.plugin_version,
            id=c.page.id,
            slot=c.page.slot,
            title=c.page.title,
            description=c.page.description,
            files=dict(c.page.files),
            anchors=dict(c.page.anchors),
            order=c.page.order,
            active=c.active,
        )
        for c in list_contributions(registry, current_user)
    ])


@router.get("/plugins/{plugin_id}/{path:path}", response_class=FileResponse)
def manual_plugin_file(
    plugin_id: str,
    path: str,
    registry: PluginRegistry = Depends(get_plugin_registry),
) -> FileResponse:
    """A file of a plugin's manual pages: Markdown or an image from the directories of the declared pages.

    Served without authentication, like the core manual. Returns 404 for any other file.
    """
    try:
        file_path, media_type = resolve_manual_file(registry, plugin_id, path)
    except ManualFileNotFound:
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(file_path, media_type=media_type, headers={"X-Content-Type-Options": "nosniff"})
