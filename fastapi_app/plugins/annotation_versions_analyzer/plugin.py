"""
Annotation Versions Analyzer plugin.

This plugin analyzes annotation versions of a PDF document including gold files
and displays the results in an HTML table.
"""

import logging
from datetime import datetime
from typing import Any, Callable

from fastapi_app.lib.plugin_base import Plugin, PluginContext

logger = logging.getLogger(__name__)

class AnnotationVersionsAnalyzerPlugin(Plugin):
    """
    Plugin that analyzes annotation versions of PDF documents and generates an HTML table.
    """

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "annotation-versions-analyzer",
            "name": "Annotation Versions Analyzer",
            "description": "Analyzes annotation versions of PDF documents including gold files",
            "version": "1.0.0",
            "category": "analyzer",
            "required_roles": ["user"],
            "endpoints": [
                {
                    "name": "analyze",
                    "label": "Analyze Annotation Versions",
                    "description": "Analyze annotation versions of the current PDF document",
                    "state_params": ["pdf", "variant"],
                },
            ],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "analyze": self.analyze,
        }

    async def analyze(self, context: PluginContext, params: dict[str, Any]) -> dict[str, Any]:
        """
        Analyze annotation versions for the given PDF document.

        Args:
            context: Plugin context
            params: Parameters including 'pdf' (PDF stable_id or file hash)

        Returns:
            HTML table with annotation version information
        """
        pdf_id = params.get("pdf")
        if not pdf_id:
            return {
                "error": "No PDF document selected",
                "html": "<p>Please select a PDF document first.</p>",
            }

        from fastapi_app.lib.dependencies import get_db, get_file_storage
        from fastapi_app.lib.file_repository import FileRepository

        try:
            db = get_db()
            file_repo = FileRepository(db)
            file_storage = get_file_storage()

            # Get doc_id from the PDF's stable_id or file hash
            doc_id = file_repo.get_doc_id_by_file_id(pdf_id)
            if not doc_id:
                return {
                    "error": "PDF file not found",
                    "html": "<p>PDF file not found.</p>",
                }

            # Get all files for this document
            all_files = file_repo.get_files_by_doc_id(doc_id)

            # Filter for TEI files only
            tei_files = [f for f in all_files if f.file_type == "tei"]

            if not tei_files:
                return {
                    "html": "<p>No annotation versions found for this PDF document.</p>",
                }

            # Get current variant filter from params
            variant_filter = params.get("variant")

            # Parse each TEI file and extract information
            versions = []
            for file_metadata in tei_files:
                if file_metadata.file_type != "tei":
                    continue

                # Filter by variant if specified (and not "all" or empty)
                if variant_filter and variant_filter not in ("all", ""):
                    # Check variant match for all files (including gold)
                    file_variant = getattr(file_metadata, "variant", None)
                    if file_variant != variant_filter:
                        continue

                try:
                    content_bytes = file_storage.read_file(file_metadata.id, "tei")
                    if not content_bytes:
                        logger.warning(f"Empty content for file {file_metadata.id}")
                        continue

                    xml_content = content_bytes.decode("utf-8")
                    version_info = self._parse_tei_version_info(xml_content, file_metadata)
                    if version_info:
                        versions.append(version_info)
                except Exception as e:
                    logger.error(f"Failed to parse TEI file {file_metadata.id}: {e}")
                    continue

            # Determine if we should show variant column
            show_variant_column = not variant_filter or variant_filter in ("all", "")

            # Sort versions: gold first, then by date (newest first)
            self._sort_versions(versions)

            # Generate HTML table
            html = self._generate_html_table(versions, show_variant_column)
            return {"html": html, "pdf": pdf_id, "variant": variant_filter or "all"}

        except Exception as e:
            logger.error(f"Failed to analyze annotation versions for PDF {pdf_id}: {e}")
            return {
                "error": str(e),
                "html": f"<p>Error analyzing annotation versions: {str(e)}</p>",
            }

    def _parse_tei_version_info(
        self, xml_content: str, file_metadata: Any
    ) -> dict[str, Any] | None:
        """
        Parse TEI XML content to extract version information.

        Args:
            xml_content: TEI XML content as string
            file_metadata: File metadata object

        Returns:
            Dictionary with version information or None if parsing fails
        """
        try:
            from lxml import etree
            from fastapi_app.lib.tei_utils import extract_tei_metadata

            # Parse XML with lxml (same as tei_utils uses)
            root = etree.fromstring(xml_content.encode("utf-8"))

            # Use the existing utility to extract metadata
            tei_metadata = extract_tei_metadata(root)

            # Get title - prefer edition_title, fallback to title from titleStmt
            title = tei_metadata.get("edition_title") or tei_metadata.get("title", "Untitled")

            # Check if this is a gold standard file
            is_gold = (
                getattr(file_metadata, "is_gold_standard", False)
                or tei_metadata.get("is_gold_standard", False)
            )

            # Extract last change information from revisionDesc
            ns = {"tei": "http://www.tei-c.org/ns/1.0"}
            last_change_elem = root.find(".//tei:revisionDesc/tei:change[last()]", ns)

            last_change_desc = ""
            last_annotator = ""
            last_change_date = ""
            when_attr = ""

            if last_change_elem is not None:
                # Get description from desc element
                desc_elem = last_change_elem.find("tei:desc", ns)
                if desc_elem is not None and desc_elem.text:
                    last_change_desc = desc_elem.text.strip()

                # Get annotator from @who attribute
                last_annotator = last_change_elem.get("who", "")

                # Get and format date from @when attribute
                when_attr = last_change_elem.get("when", "")
                if when_attr:
                    last_change_date = self._format_date(when_attr)

            return {
                "title": title,
                "is_gold": is_gold,
                "variant": getattr(file_metadata, "variant", ""),
                "last_change_desc": last_change_desc,
                "last_annotator": last_annotator,
                "last_change_date": last_change_date,
                "last_change_date_raw": when_attr,  # Store raw ISO date for sorting
                "file_id": file_metadata.id,
            }

        except Exception as e:
            logger.error(f"Error extracting version info: {e}")
            return None

    def _sort_versions(self, versions: list[dict[str, Any]]) -> None:
        """
        Sort versions in place: gold first, then by date (newest first).

        Args:
            versions: List of version information dictionaries
        """
        # Sort by: is_gold (True first), then by raw date (newest first)
        # Primary key: is_gold (True sorts before False with reverse=True)
        # Secondary key: date (newer dates sort first with reverse=True)
        versions.sort(
            key=lambda v: (
                v["is_gold"],  # True (1) > False (0), with reverse=True gold comes first
                v.get("last_change_date_raw", "") or ""  # ISO dates sort chronologically
            ),
            reverse=True  # Reverse for descending order
        )

    def _format_date(self, date_str: str) -> str:
        """
        Format ISO date string to human-readable format.

        Args:
            date_str: ISO format date string (e.g., "2024-01-15" or "2024-01-15T10:30:00")

        Returns:
            Human-readable date string
        """
        try:
            # Try parsing with time
            if "T" in date_str:
                dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
                return dt.strftime("%B %d, %Y at %I:%M %p")
            else:
                # Parse date only
                dt = datetime.strptime(date_str, "%Y-%m-%d")
                return dt.strftime("%B %d, %Y")
        except (ValueError, AttributeError) as e:
            logger.warning(f"Failed to parse date '{date_str}': {e}")
            return date_str

    def _generate_html_table(self, versions: list[dict[str, Any]], show_variant_column: bool = False) -> str:
        """
        Generate HTML table from version information.

        Args:
            versions: List of version information dictionaries (must be pre-sorted)
            show_variant_column: Whether to include variant column

        Returns:
            HTML table as string
        """
        if not versions:
            return "<p>No annotation versions found.</p>"

        # Versions are already sorted by _sort_versions (gold first, then by date)

        # Build header row
        header_cells = [
            '<th style="border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 0.9em;">Title</th>',
            '<th style="border: 1px solid #ddd; padding: 8px; text-align: center; font-size: 0.9em; width: 50px;">Gold</th>',
        ]

        if show_variant_column:
            header_cells.append(
                '<th style="border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 0.9em; width: 100px;">Variant</th>'
            )

        header_cells.extend([
            '<th style="border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 0.9em;">Last Change</th>',
            '<th style="border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 0.9em; width: 120px;">Annotator</th>',
            '<th style="border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 0.9em; width: 140px;">Date</th>',
        ])

        html_parts = [
            '<table style="width: 100%; border-collapse: collapse; font-size: 0.9em;">',
            "<thead>",
            '<tr style="background-color: #f5f5f5;">',
            *header_cells,
            "</tr>",
            "</thead>",
            "<tbody>",
        ]

        for version in versions:
            gold_icon = "✓" if version["is_gold"] else ""

            row_cells = [
                f'<td style="border: 1px solid #ddd; padding: 8px; font-size: 0.9em;">{self._escape_html(version["title"])}</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px; text-align: center; font-size: 0.9em;">{gold_icon}</td>',
            ]

            if show_variant_column:
                row_cells.append(
                    f'<td style="border: 1px solid #ddd; padding: 8px; font-size: 0.9em;">{self._escape_html(version.get("variant", ""))}</td>'
                )

            row_cells.extend([
                f'<td style="border: 1px solid #ddd; padding: 8px; font-size: 0.9em;">{self._escape_html(version["last_change_desc"])}</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px; font-size: 0.9em;">{self._escape_html(version["last_annotator"])}</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px; font-size: 0.9em;">{self._escape_html(version["last_change_date"])}</td>',
            ])

            html_parts.extend([
                "<tr>",
                *row_cells,
                "</tr>",
            ])

        html_parts.extend([
            "</tbody>",
            "</table>",
        ])

        return "".join(html_parts)

    def _escape_html(self, text: str) -> str:
        """
        Escape HTML special characters.

        Args:
            text: Text to escape

        Returns:
            Escaped text
        """
        if not text:
            return ""
        return (
            text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;")
            .replace("'", "&#x27;")
        )
