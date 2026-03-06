"""
XSLT export plugin.

Provides XSLT transformations for TEI documents independently of GROBID.
"""

import logging
from typing import Any, Callable

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.plugins.frontend_extension_registry import FrontendExtensionRegistry
from pathlib import Path

logger = logging.getLogger(__name__)


class XsltExportPlugin(Plugin):
    """Plugin that provides XSLT transformations for TEI documents."""

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "xslt-export",
            "name": "XSLT Export",
            "description": "Provides XSLT transformations for TEI documents",
            "category": "exporter",
            "version": "1.0.0",
            "required_roles": ["user"],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {}

    @classmethod
    def is_available(cls) -> bool:
        """XSLT export plugin is always available."""
        return True

    async def initialize(self, context: PluginContext) -> None:
        """Register the frontend extension."""
        # Register frontend extension
        fe_registry = FrontendExtensionRegistry.get_instance()
        extension_file = Path(__file__).parent / "extensions" / "tei-xslt.js"
        if extension_file.exists():
            fe_registry.register_extension(extension_file, self.metadata["id"])
            logger.info("Registered TEI XSLT frontend extension")

        logger.info("XSLT export plugin initialized")

    async def cleanup(self) -> None:
        """Cleanup plugin resources."""
        logger.info("XSLT export plugin cleaned up")