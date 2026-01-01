"""
Annotation Progress Plugin.

This plugin provides an overview of annotation progress for documents in a collection
by analyzing revision information from TEI artifacts.
"""

import logging
from typing import Any, Callable

from lxml import etree

from fastapi_app.lib.plugin_base import Plugin, PluginContext

logger = logging.getLogger(__name__)


class AnnotationProgressPlugin(Plugin):
    """
    Plugin that generates annotation progress reports for collections.
    """

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "annotation-progress",
            "name": "Annotation Progress",
            "description": "View annotation progress in the current collection",
            "version": "1.0.0",
            "category": "collection",
            "required_roles": ["user"],
            "endpoints": [
                {
                    "name": "show_progress",
                    "label": "Show Annotation Progress",
                    "description": "Display annotation overview for current collection",
                    "state_params": ["collection", "variant"],
                },
            ],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "show_progress": self.show_progress,
        }

    async def show_progress(
        self, context: PluginContext, params: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Generate annotation progress report for current collection.

        Args:
            context: Plugin context
            params: Parameters including 'collection' and 'variant'

        Returns:
            outputUrl pointing to the view route
        """
        collection_id = params.get("collection")
        if not collection_id:
            return {
                "error": "No collection selected",
                "html": "<p>Please select a collection first.</p>",
            }

        variant_filter = params.get("variant")

        # Build URL
        variant_param = f"&variant={variant_filter}" if variant_filter else ""
        view_url = f"/api/plugins/annotation-progress/view?collection={collection_id}{variant_param}"

        return {
            "outputUrl": view_url,
            "collection": collection_id,
            "variant": variant_filter or "all",
        }

    def _extract_annotation_info(
        self, xml_content: str, file_metadata: Any
    ) -> dict[str, Any] | None:
        """
        Extract annotation information from TEI document.

        Args:
            xml_content: TEI XML content as string
            file_metadata: File metadata object

        Returns:
            Dictionary with annotation label and revision count, or None if parsing fails
        """
        try:
            from fastapi_app.lib.tei_utils import extract_tei_metadata

            root = etree.fromstring(xml_content.encode("utf-8"))
            ns = {
                "tei": "http://www.tei-c.org/ns/1.0",
            }

            # Get extraction label from edition title
            tei_metadata = extract_tei_metadata(root)
            # Use edition_title (extraction label) if available, fallback to title
            annotation_label = tei_metadata.get("edition_title") or tei_metadata.get(
                "title", "Untitled"
            )

            # Count all change elements (revision count)
            change_elements = root.findall(".//tei:revisionDesc/tei:change", ns)
            revision_count = len(change_elements)

            return {
                "annotation_label": annotation_label,
                "revision_count": revision_count,
                "stable_id": file_metadata.stable_id,
            }

        except Exception as e:
            logger.error(f"Error extracting annotation info: {e}")
            return None
