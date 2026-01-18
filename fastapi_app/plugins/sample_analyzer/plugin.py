"""
Sample analyzer plugin for testing the plugin system.

This plugin demonstrates the basic plugin structure and provides
a simple text analysis endpoint. Also registers the MockExtractor
for testing extraction functionality.
"""

import logging
import os
from typing import Any, Callable

from fastapi_app.lib.plugin_base import Plugin, PluginContext
from fastapi_app.lib.extraction import ExtractorRegistry
from .extractor import MockExtractor

logger = logging.getLogger(__name__)


class SampleAnalyzerPlugin(Plugin):
    """
    Sample analyzer plugin that performs basic text analysis.
    """

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "sample-analyzer",
            "name": "Sample Text Analyzer",
            "description": "Analyzes text and returns basic statistics",
            "version": "1.0.0",
            "category": "test",
            "required_roles": ["user"],  # Requires user role
            "endpoints": [
                {
                    "name": "execute",
                    "label": "Analyze Current XML",
                    "description": "Analyze the currently open XML document",
                    "state_params": ["xml", "variant"],
                },
                {
                    "name": "info",
                    "label": "Plugin Info",
                    "description": "Get plugin information",
                    "state_params": [],
                },
            ],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "execute": self.execute,
            "info": self.info,
        }

    @classmethod
    def is_available(cls) -> bool:
        """Sample analyzer available only in development and testing modes."""
        app_mode = os.environ.get("FASTAPI_APPLICATION_MODE", "development")
        return app_mode in ("testing")

    async def initialize(self, context: PluginContext) -> None:
        """Initialize plugin and register MockExtractor in testing mode."""
        # Register MockExtractor for testing
        if MockExtractor.is_available():
            registry = ExtractorRegistry.get_instance()
            registry.register(MockExtractor)
            logger.info("MockExtractor registered for testing")
        logger.info("Sample analyzer plugin initialized")

    async def cleanup(self) -> None:
        """Cleanup plugin and unregister MockExtractor."""
        # Unregister MockExtractor
        if MockExtractor.is_available():
            registry = ExtractorRegistry.get_instance()
            registry.unregister("mock-extractor")
            logger.info("MockExtractor unregistered")
        logger.info("Sample analyzer plugin cleaned up")

    async def execute(self, context: PluginContext, params: dict[str, Any]) -> dict[str, Any]:
        """
        Execute text analysis.

        Args:
            context: Plugin context
            params: Parameters including optional 'xml', 'variant', or 'text' to analyze

        Returns:
            Analysis results with character count, word count, line count
        """
        # Extract state parameters if provided
        xml_id = params.get("xml")
        variant = params.get("variant")

        # Get text either from params or from file content
        text = params.get("text", "")

        if not text and xml_id:
            # If xml id provided but no text, fetch file content
            from fastapi_app.lib.dependencies import get_db, get_file_storage

            try:
                db = get_db()
                file_storage = get_file_storage()

                # Get file metadata
                from fastapi_app.lib.file_repository import FileRepository
                file_repo = FileRepository(db)
                file_metadata = file_repo.get_file_by_id_or_stable_id(xml_id)

                if file_metadata and file_metadata.file_type == "tei":
                    # Read file content
                    content_bytes = file_storage.read_file(file_metadata.id, "tei")
                    if content_bytes:
                        text = content_bytes.decode("utf-8")
                    else:
                        raise ValueError(f"File content not found for {xml_id}")
                else:
                    raise ValueError(f"XML file not found: {xml_id}")
            except Exception as e:
                logger.error(f"Failed to load XML file {xml_id}: {e}")
                raise

        if not isinstance(text, str):
            raise ValueError("Parameter 'text' must be a string")

        # Perform basic analysis
        char_count = len(text)
        word_count = len(text.split())
        line_count = len(text.splitlines())

        # Count unique words
        words = text.lower().split()
        unique_words = len(set(words))

        result = {
            "analysis": {
                "character_count": char_count,
                "word_count": word_count,
                "line_count": line_count,
                "unique_words": unique_words,
                "average_word_length": (
                    sum(len(word) for word in words) / len(words) if words else 0
                ),
            },
            "text_preview": text[:100] + ("..." if len(text) > 100 else ""),
        }

        # Include document context if provided
        if xml_id:
            result["document"] = {"xml": xml_id, "variant": variant}

        return result

    async def info(self, context: PluginContext, params: dict[str, Any]) -> dict[str, Any]:
        """
        Return plugin information.

        Args:
            context: Plugin context
            params: Parameters (unused)

        Returns:
            Plugin information
        """
        return {
            "plugin": self.metadata["name"],
            "version": self.metadata["version"],
            "message": "Sample analyzer ready to analyze text",
        }
