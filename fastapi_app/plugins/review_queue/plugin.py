"""
Review Queue Plugin.

Contributes a "Waiting for review" box to the login dashboard, listing all documents
the user can access whose lifecycle status is one of the configured statuses
(`plugin.review-queue.statuses`).
"""

import logging
from pathlib import Path
from typing import Any, Callable

from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.plugins.plugin_tools import get_plugin_config

logger = logging.getLogger(__name__)


class ReviewQueuePlugin(Plugin):
    """Plugin listing documents waiting for review on the dashboard."""

    def __init__(self):
        get_plugin_config(
            "plugin.review-queue.statuses",
            "PLUGIN_REVIEW_QUEUE_STATUSES",
            default=["in-review"],
            value_type="array",
            description="Lifecycle statuses (from annotation.lifecycle.order) of the documents listed in the dashboard's 'Waiting for review' box",
        )

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "review-queue",
            "name": "Review Queue",
            "description": "Dashboard box listing the documents waiting for review",
            "category": "document",
            "version": "1.0.0",
            "required_roles": ["reviewer", "admin"],
            "dependencies": ["dashboard"],
            "endpoints": [],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        return {}

    async def initialize(self, context: PluginContext) -> None:
        """Register the frontend extension that contributes the dashboard box."""
        fe_registry = FrontendExtensionRegistry.get_instance()
        extension_file = Path(__file__).parent / "extensions" / "review-queue.js"
        if extension_file.exists():
            fe_registry.register_extension(extension_file, self.metadata["id"])
