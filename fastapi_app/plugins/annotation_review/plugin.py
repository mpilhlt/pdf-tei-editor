"""
Annotation Review plugin.

Reviews a document's annotations against its own editorialDecl-linked
rules using an LLM, via the shared LLMProviderRegistry. The routes are in
routes.py; the frontend extension adds the Tools-menu trigger and shows the
findings as editor diagnostics. See README.md.

See docs/superpowers/specs/2026-09-24-llm-annotation-review-design.md
(Part C) for the design rationale.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi_app.lib.plugins.frontend_extension_registry import (
    FrontendExtensionRegistry,
)
from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext

logger = logging.getLogger(__name__)


class AnnotationReviewPlugin(Plugin):
    """Plugin that reviews a document's annotations against its own editorialDecl rules."""

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "annotation-review",
            "name": "Annotation Review",
            "description": "Reviews a document's annotations against its own editorialDecl-linked rules using an LLM",
            "category": "annotation",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": [],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        return {}

    async def initialize(self, context: PluginContext) -> None:
        """Register the frontend extension."""
        registry = FrontendExtensionRegistry.get_instance()
        extension_file = Path(__file__).parent / "extensions" / "annotation-review.js"
        if extension_file.exists():
            registry.register_extension(extension_file, self.metadata["id"])
            logger.info("Annotation Review frontend extension registered")
        else:
            logger.warning("Annotation Review frontend extension not found at %s", extension_file)

    async def cleanup(self) -> None:
        pass
