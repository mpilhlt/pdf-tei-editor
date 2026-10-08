"""
Revision Feed Plugin.

Exposes a per-user-token-authenticated Atom feed (per project) of TEI
revisionDesc changes whose status is in a configurable allowlist. See
docs/superpowers/specs/2026-10-07-revision-feed-plugin-design.md.
"""

import logging
from pathlib import Path
from typing import Any, Callable

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.plugins.plugin_tools import get_plugin_config

logger = logging.getLogger(__name__)


class RevisionFeedPlugin(Plugin):
    """Plugin providing per-project Atom feeds of document revisions."""

    def __init__(self):
        from fastapi_app.lib.utils.config_utils import get_config

        lifecycle_order = get_config().get("annotation.lifecycle.order", default=[])
        default_statuses = [status for status in lifecycle_order if status != "extraction"]

        get_plugin_config(
            "plugin.revision-feed.included-statuses",
            "REVISION_FEED_INCLUDED_STATUSES",
            default=default_statuses,
            value_type="array",
            description="Lifecycle statuses whose revisionDesc changes appear in the revision feed",
        )

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "revision-feed",
            "name": "Revision Feed",
            "description": "Per-project Atom feeds of document revisions",
            "version": "1.0.0",
            "category": "collection",
            "required_roles": ["user"],
            "endpoints": [],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        return {}

    async def initialize(self, context: PluginContext) -> None:
        """Register the frontend extension that adds the user-menu entry."""
        from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry

        fe_registry = FrontendExtensionRegistry.get_instance()
        extension_file = Path(__file__).parent / "extensions" / "revision-feed.js"
        if extension_file.exists():
            fe_registry.register_extension(extension_file, self.metadata["id"])

        logger.info("Revision feed plugin initialized")
