"""
Edit History Plugin.

This plugin creates a report about recent activity in the current collection
by analyzing revision information from TEI artifacts.
"""

import logging
from datetime import datetime
from typing import Any, Callable

from lxml import etree

from fastapi_app.lib.plugin_base import Plugin, PluginContext

logger = logging.getLogger(__name__)


class EditHistoryPlugin(Plugin):
    """
    Plugin that generates edit history reports for collections.
    """

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "edit-history",
            "name": "Edit History",
            "description": "View recent activity in the current collection",
            "version": "1.0.0",
            "category": "collection",
            "required_roles": ["user"],
            "endpoints": [
                {
                    "name": "show_history",
                    "label": "Show Edit History",
                    "description": "Display recent changes in current collection",
                    "state_params": ["collection", "variant"],
                },
            ],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "show_history": self.show_history,
        }

    async def show_history(
        self, context: PluginContext, params: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Generate edit history report for current collection.

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
        session_id = params.get("_session_id", "")

        # Build URLs
        variant_param = f"&variant={variant_filter}" if variant_filter else ""
        view_url = f"/api/plugins/edit-history/view?collection={collection_id}{variant_param}"
        export_url = f"/api/plugins/edit-history/export?collection={collection_id}{variant_param}"

        return {
            "outputUrl": view_url,
            "exportUrl": export_url,
            "collection": collection_id,
            "variant": variant_filter or "all",
        }

    def _extract_revision_info(
        self, xml_content: str, file_metadata: Any
    ) -> list[dict[str, Any]]:
        """
        Extract revision information from TEI document.

        Args:
            xml_content: TEI XML content as string
            file_metadata: File metadata object

        Returns:
            List of revision entries with timestamp, doc_id, label, description, who
        """
        try:
            from fastapi_app.lib.tei_utils import extract_tei_metadata, get_annotator_name

            root = etree.fromstring(xml_content.encode("utf-8"))
            ns = {
                "tei": "http://www.tei-c.org/ns/1.0",
            }

            # Get extraction label from edition title
            tei_metadata = extract_tei_metadata(root)
            # Use edition_title (extraction label) if available, fallback to title
            doc_label = tei_metadata.get("edition_title") or tei_metadata.get(
                "title", "Untitled"
            )

            # Get the last change element
            last_change = root.find(".//tei:revisionDesc/tei:change[last()]", ns)

            if last_change is None:
                return []

            # Extract change information
            when = last_change.get("when", "")
            who_id = last_change.get("who", "")
            status = last_change.get("status", "draft")

            # Look up full name from respStmt using @xml:id
            who_name = get_annotator_name(root, who_id)

            # Get description from text content or desc subelement
            desc_elem = last_change.find("tei:desc", ns)
            if desc_elem is not None and desc_elem.text:
                description = desc_elem.text.strip()
            elif last_change.text:
                description = last_change.text.strip()
            else:
                description = "No description"

            # Parse timestamp
            try:
                # Try ISO format first
                timestamp = datetime.fromisoformat(when.replace("Z", "+00:00"))
                # Remove timezone info for consistent comparison
                if timestamp.tzinfo is not None:
                    timestamp = timestamp.replace(tzinfo=None)
            except (ValueError, AttributeError):
                # Fallback to current time if parsing fails
                timestamp = datetime.now()

            # Get doc_id from file metadata
            doc_id = file_metadata.doc_id or "Unknown"

            return [
                {
                    "timestamp": timestamp,
                    "date_str": timestamp.strftime("%Y-%m-%d\u00a0%H:%M:%S"),  # Non-breaking space
                    "doc_id": doc_id,
                    "doc_label": doc_label,
                    "description": description,
                    "who": who_name,
                    "status": status,
                    "stable_id": file_metadata.stable_id,
                }
            ]

        except Exception as e:
            logger.error(f"Error extracting revision info: {e}")
            return []
