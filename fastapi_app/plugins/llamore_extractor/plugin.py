"""
LLamore extractor plugin.

Registers the LLamoreExtractor with the extraction registry.
"""

import logging
from typing import Any, Callable, Optional

from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.doc_rules.rules_providers import register_document_rules_provider, unregister_document_rules_provider
from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.extraction import ExtractorRegistry
from fastapi_app.lib.utils.annotation_rules_utils import AnnotationRuleRef
from .config import get_schema_url, init_plugin_config
from .extractor import LLamoreExtractor

logger = logging.getLogger(__name__)


class LlamoreRulesProvider:
    """
    Adapts this plugin's schema config to the DocumentRulesProvider
    protocol so "Refresh document rules" (a core action, see
    fastapi_app/lib/doc_rules/rules_refresh.py) can dispatch to it.
    Registered once, in LLamorePlugin.initialize().

    build_editorial_decl_entries() returns [] - this extractor's only
    editorialDecl entry today ("additional-instructions", see
    extractor.py's _resolve_additional_instructions()) is generated per-
    extraction from the user's own selected override, not from a
    re-derivable config the way GROBID's annotation guides are, so there is
    nothing here for a refresh to regenerate. ANNOTATION_GUIDES in
    config.py feeds a separate, older mechanism (the Annotation Guide
    drawer, via get_info()'s annotationGuides field) unrelated to
    editorialDecl.
    """

    def build_editorial_decl_entries(self, variant_id: str, cache: UrlCache) -> list[AnnotationRuleRef]:
        return []

    def get_schema_url(self, variant_id: str) -> Optional[str]:
        return get_schema_url(variant_id)


class LLamorePlugin(Plugin):
    """Plugin that provides LLamore-based extraction."""

    def __init__(self) -> None:
        init_plugin_config()

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "llamore",
            "name": "LLamore Extractor",
            "description": "Extract references using LLamore with Gemini AI",
            "category": "extractor",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": []  # No menu items - accessed via extraction API
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {}  # Extractor accessed via /api/v1/extract endpoint

    @classmethod
    def is_available(cls) -> bool:
        """Check if LLamore extractor is available."""
        return LLamoreExtractor.is_available()

    async def initialize(self, context: PluginContext) -> None:
        """Register the LLamore extractor and its DocumentRulesProvider."""
        registry = ExtractorRegistry.get_instance()
        registry.register(LLamoreExtractor)
        register_document_rules_provider("llamore", "llamore", LlamoreRulesProvider())
        logger.info("LLamore extractor plugin initialized")

    async def cleanup(self) -> None:
        """Unregister the LLamore extractor and its DocumentRulesProvider."""
        registry = ExtractorRegistry.get_instance()
        registry.unregister("llamore-gemini")
        unregister_document_rules_provider("llamore")
        logger.info("LLamore extractor plugin cleaned up")
