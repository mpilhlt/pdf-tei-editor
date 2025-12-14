"""
Sample analyzer plugin for testing the plugin system.

This plugin demonstrates the basic plugin structure and provides
a simple text analysis endpoint.
"""

import logging
from typing import Any, Callable

from fastapi_app.lib.plugin_base import Plugin, PluginContext

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
            "category": "analyzer",
            "required_roles": ["admin"],  # Requires user role (all authenticated users)
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "execute": self.execute,
            "info": self.info,
        }

    async def initialize(self, context: PluginContext) -> None:
        """Initialize plugin (optional lifecycle hook)."""
        logger.info("Sample analyzer plugin initialized")

    async def cleanup(self) -> None:
        """Cleanup plugin (optional lifecycle hook)."""
        logger.info("Sample analyzer plugin cleaned up")

    async def execute(self, context: PluginContext, params: dict[str, Any]) -> dict[str, Any]:
        """
        Execute text analysis.

        Args:
            context: Plugin context
            params: Parameters including 'text' to analyze

        Returns:
            Analysis results with character count, word count, line count
        """
        text = params.get("text", "")

        if not isinstance(text, str):
            raise ValueError("Parameter 'text' must be a string")

        # Perform basic analysis
        char_count = len(text)
        word_count = len(text.split())
        line_count = len(text.splitlines())

        # Count unique words
        words = text.lower().split()
        unique_words = len(set(words))

        return {
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
