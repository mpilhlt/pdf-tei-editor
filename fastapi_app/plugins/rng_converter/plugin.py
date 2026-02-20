"""
RNG Converter Plugin.

This plugin converts TEI XML documents to RelaxNG schemas.
"""

import logging
from typing import Any, Callable

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext

logger = logging.getLogger(__name__)


class RngConverterPlugin(Plugin):
    """
    Plugin that converts TEI documents to RelaxNG schemas.
    """

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "rng-converter",
            "name": "RelaxNG Schema Generator",
            "description": "Generate RelaxNG schema from TEI document structure",
            "version": "1.0.0",
            "category": "converter",
            "required_roles": ["reviewer"],
            "endpoints": [
                {
                    "name": "convert_to_rng",
                    "label": "Generate RelaxNG Schema",
                    "description": "Create a RelaxNG schema from the current TEI document",
                    "state_params": ["xml", "variant"],
                },
            ],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "convert_to_rng": self.convert_to_rng,
        }

    async def convert_to_rng(
        self, context: PluginContext, params: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Generate RelaxNG schema from current TEI document.

        Args:
            context: Plugin context
            params: Parameters including 'xml' (file ID) and 'variant'

        Returns:
            HTML with download link
        """
        xml_file_id = params.get("xml")
        if not xml_file_id:
            return {
                "error": "No TEI document selected",
                "html": "<p>Please open a TEI document first.</p>",
            }

        variant = params.get("variant", "rng-schema")

        # Build export URL for the built-in export button
        export_url = f"/api/plugins/rng-converter/download?file_id={xml_file_id}&variant={variant}"

        # Simple HTML description - the export button is provided by the framework
        html = f"""
        <div style="padding: 20px; font-family: system-ui, -apple-system, sans-serif;">
            <h3 style="margin-top: 0;">RelaxNG Schema Generator</h3>
            <p>A RelaxNG schema will be generated from the structure of the current TEI document.</p>
            <p style="margin-top: 15px;">Click the <strong>Export</strong> button below to download the schema.</p>
            <p style="font-size: 0.9em; color: #666; margin-top: 20px;">
                The schema can be used to validate other TEI documents with similar structure.
            </p>
        </div>
        """

        return {
            "html": html,
            "exportUrl": export_url,
            "xml": xml_file_id,
            "variant": variant,
        }
