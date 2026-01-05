"""
Annotation History Plugin.

This plugin provides a detailed view of annotation history for PDF documents,
showing all TEI versions with their complete revision history in a nested table.
"""

import logging
from datetime import datetime
from typing import Any, Callable

from fastapi_app.lib.plugin_base import Plugin, PluginContext

logger = logging.getLogger(__name__)


class AnnotationHistoryPlugin(Plugin):
    """
    Plugin that displays detailed annotation history with nested revision view.
    """

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "annotation-history",
            "name": "Annotation History",
            "description": "Shows detailed annotation history for PDF documents",
            "version": "1.0.0",
            "category": "document",
            "required_roles": ["user"],
            "endpoints": [
                {
                    "name": "analyze",
                    "label": "Show Annotation History",
                    "description": "Shows detailed annotation history of the current PDF document",
                    "state_params": ["pdf", "variant"],
                },
            ],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "analyze": self.analyze,
        }

    async def analyze(
        self, context: PluginContext, params: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Analyze annotation history for the given PDF document.

        Args:
            context: Plugin context
            params: Parameters including 'pdf' (PDF stable_id or file hash) and 'variant'

        Returns:
            outputUrl pointing to the view route and exportUrl for CSV download
        """
        pdf_id = params.get("pdf")
        if not pdf_id:
            return {
                "error": "No PDF document selected",
                "html": "<p>Please select a PDF document first.</p>",
            }

        variant_filter = params.get("variant")

        # Build URLs
        variant_param = f"&variant={variant_filter}" if variant_filter else ""
        view_url = f"/api/plugins/annotation-history/view?pdf={pdf_id}{variant_param}"
        export_url = f"/api/plugins/annotation-history/export?pdf={pdf_id}{variant_param}"

        return {
            "outputUrl": view_url,
            "exportUrl": export_url,
            "pdf": pdf_id,
            "variant": variant_filter or "all",
        }

    def _parse_tei_document_info(
        self, xml_content: str, file_metadata: Any
    ) -> dict[str, Any] | None:
        """
        Parse TEI XML content to extract document and all revision information.

        Args:
            xml_content: TEI XML content as string
            file_metadata: File metadata object

        Returns:
            Dictionary with document info and all revisions or None if parsing fails
        """
        try:
            from lxml import etree

            from fastapi_app.lib.tei_utils import extract_tei_metadata, get_annotator_name

            # Parse XML with lxml
            root = etree.fromstring(xml_content.encode("utf-8"))

            # Use the existing utility to extract metadata
            tei_metadata = extract_tei_metadata(root)

            # Get title - prefer edition_title, fallback to title from titleStmt
            title = tei_metadata.get("edition_title") or tei_metadata.get(
                "title", "Untitled"
            )

            # Check if this is a gold standard file
            is_gold = getattr(file_metadata, "is_gold_standard", False) or tei_metadata.get(
                "is_gold_standard", False
            )

            # Extract ALL change elements
            ns = {"tei": "http://www.tei-c.org/ns/1.0"}
            change_elements = root.findall(".//tei:revisionDesc/tei:change", ns)

            revisions = []
            for change_elem in change_elements:
                # Get description from desc element
                desc_elem = change_elem.find("tei:desc", ns)
                change_desc = (
                    desc_elem.text.strip()
                    if desc_elem is not None and desc_elem.text
                    else ""
                )

                # Get annotator from @who attribute and look up full name
                who_id = change_elem.get("who", "")
                annotator = get_annotator_name(root, who_id)

                # Get status attribute
                status = change_elem.get("status", "draft")

                # Get and format date from @when attribute
                when_attr = change_elem.get("when", "")
                change_date = self._format_date(when_attr) if when_attr else ""

                revisions.append(
                    {
                        "desc": change_desc,
                        "annotator": annotator,
                        "status": status,
                        "date": change_date,
                        "date_raw": when_attr,  # Store raw ISO date for sorting
                    }
                )

            # Get last change for collapsed view summary
            if revisions:
                last_change = revisions[-1]
            else:
                last_change = {
                    "desc": "",
                    "annotator": "",
                    "status": "",
                    "date": "",
                    "date_raw": "",
                }

            return {
                "title": title,
                "is_gold": is_gold,
                "variant": getattr(file_metadata, "variant", ""),
                "stable_id": file_metadata.stable_id,
                "last_change": last_change,
                "revisions": revisions,  # All changes in chronological order
            }

        except Exception as e:
            logger.error(f"Error extracting document info: {e}")
            return None

    def _sort_documents(self, documents: list[dict[str, Any]]) -> None:
        """
        Sort documents in place: gold first, then by last change date (newest first).

        Args:
            documents: List of document information dictionaries
        """
        # Sort by: is_gold (True first), then by last change date (newest first)
        documents.sort(
            key=lambda d: (
                d["is_gold"],  # True (1) > False (0), with reverse=True gold comes first
                d["last_change"].get("date_raw", "") or "",  # ISO dates sort chronologically
            ),
            reverse=True,  # Reverse for descending order
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
                return dt.strftime("%B %d, %Y at %H:%M")
            else:
                # Parse date only
                dt = datetime.strptime(date_str, "%Y-%m-%d")
                return dt.strftime("%B %d, %Y")
        except (ValueError, AttributeError) as e:
            logger.warning(f"Failed to parse date '{date_str}': {e}")
            return date_str

    def _generate_nested_table(
        self, documents: list[dict[str, Any]], show_variant_column: bool = False
    ) -> str:
        """
        Generate nested HTML table from document information.

        Args:
            documents: List of document information dictionaries (must be pre-sorted)
            show_variant_column: Whether to include variant column

        Returns:
            HTML table as string
        """
        if not documents:
            return "<p>No annotation versions found.</p>"

        # Calculate colspan for nested table
        colspan = 6  # expand, title, gold, last change, annotator, status, date
        if show_variant_column:
            colspan += 1

        html_parts = [
            '<div style="margin-bottom: 1rem;">',
            '<button onclick="expandAll()" style="margin-right: 0.5rem; padding: 0.5rem 1rem; cursor: pointer;">Expand All</button>',
            '<button onclick="collapseAll()" style="padding: 0.5rem 1rem; cursor: pointer;">Collapse All</button>',
            "</div>",
            '<table style="width: 100%; border-collapse: collapse; font-size: 0.9em;">',
            "<thead>",
            '<tr style="background-color: #f5f5f5;">',
            '<th style="border: 1px solid #ddd; padding: 8px; width: 30px;"></th>',  # Expand/collapse column
        ]

        # Header columns
        header_cells = [
            '<th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Title</th>',
            '<th style="border: 1px solid #ddd; padding: 8px; text-align: center; width: 50px;">Gold</th>',
        ]

        if show_variant_column:
            header_cells.append(
                '<th style="border: 1px solid #ddd; padding: 8px; text-align: left; width: 100px;">Variant</th>'
            )

        header_cells.extend(
            [
                '<th style="border: 1px solid #ddd; padding: 8px; text-align: left;">Last Change</th>',
                '<th style="border: 1px solid #ddd; padding: 8px; text-align: left; width: 120px;">Annotator</th>',
                '<th style="border: 1px solid #ddd; padding: 8px; text-align: left; width: 100px;">Status</th>',
                '<th style="border: 1px solid #ddd; padding: 8px; text-align: left; width: 140px;">Date</th>',
            ]
        )

        html_parts.extend(header_cells)
        html_parts.extend(["</tr>", "</thead>", "<tbody>"])

        # Generate rows for each document
        for idx, doc in enumerate(documents):
            # Collapsed row (document summary)
            html_parts.append(
                self._generate_document_row(doc, idx, show_variant_column)
            )

            # Expanded row (nested revision table)
            if doc["revisions"]:
                html_parts.append(
                    self._generate_revision_rows(doc, idx, show_variant_column)
                )

        html_parts.extend(["</tbody>", "</table>"])

        # Add JavaScript for expand/collapse functionality
        html_parts.append(
            """
<script>
function toggleRow(idx) {
  const detailRows = document.querySelectorAll('.detail-row-' + idx);
  const expandIcon = document.getElementById('expand-' + idx);
  const isCollapsed = detailRows[0].style.display === 'none' || detailRows[0].style.display === '';

  detailRows.forEach(row => {
    row.style.display = isCollapsed ? 'table-row' : 'none';
  });
  expandIcon.textContent = isCollapsed ? '▼' : '▶';
}

function expandAll() {
  document.querySelectorAll('[class^="detail-row-"]').forEach(row => {
    row.style.display = 'table-row';
  });
  document.querySelectorAll('[id^="expand-"]').forEach(icon => {
    icon.textContent = '▼';
  });
}

function collapseAll() {
  document.querySelectorAll('[class^="detail-row-"]').forEach(row => {
    row.style.display = 'none';
  });
  document.querySelectorAll('[id^="expand-"]').forEach(icon => {
    icon.textContent = '▶';
  });
}
</script>
"""
        )

        return "".join(html_parts)

    def _generate_document_row(
        self, doc: dict[str, Any], idx: int, show_variant_column: bool
    ) -> str:
        """
        Generate document summary row (collapsed view).

        Args:
            doc: Document information dictionary
            idx: Row index for expand/collapse ID
            show_variant_column: Whether to include variant column

        Returns:
            HTML row string
        """
        gold_icon = "✓" if doc["is_gold"] else ""
        title_link = f'<a href="#" onclick="sandbox.openDocument(\'{doc["stable_id"]}\'); return false;" style="color: #0066cc; text-decoration: underline;">{self._escape_html(doc["title"])}</a>'

        last = doc["last_change"]

        cells = [
            f'<td style="border: 1px solid #ddd; padding: 8px; cursor: pointer;" onclick="toggleRow({idx})">',
            f'<span id="expand-{idx}">▶</span>',
            "</td>",
            f'<td style="border: 1px solid #ddd; padding: 8px;">{title_link}</td>',
            f'<td style="border: 1px solid #ddd; padding: 8px; text-align: center;">{gold_icon}</td>',
        ]

        if show_variant_column:
            cells.append(
                f'<td style="border: 1px solid #ddd; padding: 8px;">{self._escape_html(doc.get("variant", ""))}</td>'
            )

        cells.extend(
            [
                f'<td style="border: 1px solid #ddd; padding: 8px;">{self._escape_html(last["desc"])}</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px;">{self._escape_html(last["annotator"])}</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px;">{self._escape_html(last["status"])}</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px;">{self._escape_html(last["date"])}</td>',
            ]
        )

        return "<tr>" + "".join(cells) + "</tr>"

    def _generate_revision_rows(
        self, doc: dict[str, Any], idx: int, show_variant_column: bool
    ) -> str:
        """
        Generate nested revision table row (expanded view).

        Args:
            doc: Document information dictionary
            idx: Row index for expand/collapse ID
            show_variant_column: Whether variant column is shown

        Returns:
            HTML row string with nested table aligned to parent columns
        """
        if not doc["revisions"]:
            return ""

        # Build header row with empty cells for caret, title, gold (and variant if shown)
        parts = [
            f'<tr id="detail-{idx}" class="detail-row-{idx}" style="display: none; background-color: #f9f9f9;">',
            '<td style="border: 1px solid #ddd; padding: 0;"></td>',  # Empty caret column
            '<td style="border: 1px solid #ddd; padding: 0;"></td>',  # Empty title column
            '<td style="border: 1px solid #ddd; padding: 0;"></td>',  # Empty gold column
        ]

        if show_variant_column:
            parts.append('<td style="border: 1px solid #ddd; padding: 0;"></td>')  # Empty variant column

        # Add nested table header cells aligned with parent columns
        parts.extend([
            '<td style="border: 1px solid #ddd; padding: 0; background-color: #e9e9e9;"><strong style="padding: 8px; display: block;">Change</strong></td>',
            '<td style="border: 1px solid #ddd; padding: 0; background-color: #e9e9e9; width: 120px;"><strong style="padding: 8px; display: block;">Annotator</strong></td>',
            '<td style="border: 1px solid #ddd; padding: 0; background-color: #e9e9e9; width: 100px;"><strong style="padding: 8px; display: block;">Status</strong></td>',
            '<td style="border: 1px solid #ddd; padding: 0; background-color: #e9e9e9; width: 140px;"><strong style="padding: 8px; display: block;">Date</strong></td>',
            '</tr>',
        ])

        # Generate data rows
        for revision in doc["revisions"]:
            parts.extend([
                f'<tr class="detail-row-{idx}" style="display: none; background-color: #f9f9f9;">',
                '<td style="border: 1px solid #ddd; padding: 0;"></td>',  # Empty caret column
                '<td style="border: 1px solid #ddd; padding: 0;"></td>',  # Empty title column
                '<td style="border: 1px solid #ddd; padding: 0;"></td>',  # Empty gold column
            ])

            if show_variant_column:
                parts.append('<td style="border: 1px solid #ddd; padding: 0;"></td>')  # Empty variant column

            parts.extend([
                f'<td style="border: 1px solid #ddd; padding: 8px;">{self._escape_html(revision["desc"])}</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px;">{self._escape_html(revision["annotator"])}</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px;">{self._escape_html(revision["status"])}</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px;">{self._escape_html(revision["date"])}</td>',
                '</tr>',
            ])

        return "".join(parts)

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

    def _escape_csv(self, text: str) -> str:
        """
        Escape text for CSV output.

        Args:
            text: Text to escape

        Returns:
            CSV-escaped text
        """
        if not text:
            return ""
        # If text contains comma, quote, or newline, wrap in quotes and escape quotes
        if ',' in text or '"' in text or '\n' in text:
            return f'"{text.replace(chr(34), chr(34) + chr(34))}"'
        return text

    def _generate_csv(
        self, documents: list[dict[str, Any]], show_variant_column: bool
    ) -> str:
        """
        Generate CSV export of annotation history.

        Args:
            documents: List of document dictionaries with revision info
            show_variant_column: Whether to include variant column

        Returns:
            CSV string with annotation history
        """
        import csv
        from io import StringIO

        output = StringIO()
        writer = csv.writer(output)

        # Write header row
        headers = ["Title", "Gold", "Change", "Annotator", "Status", "Date"]
        if show_variant_column:
            headers.insert(2, "Variant")
        writer.writerow(headers)

        # Write data rows
        for doc in documents:
            # Base values that will be repeated for child rows
            title = doc["title"]
            gold = "Yes" if doc["is_gold"] else "No"
            variant = doc.get("variant", "")

            # Write a row for each revision
            for revision in doc["revisions"]:
                row = [
                    title,
                    gold,
                ]
                if show_variant_column:
                    row.append(variant)
                row.extend([
                    revision["desc"],
                    revision["annotator"],
                    revision["status"],
                    revision["date"],
                ])
                writer.writerow(row)

        return output.getvalue()

    def _get_table_css(self) -> str:
        """
        Get CSS styles for the nested table.

        Returns:
            CSS string for table styling
        """
        return """
        table {
            border-collapse: collapse;
            width: 100%;
            font-size: 0.9em;
        }
        th, td {
            border: 1px solid #ddd;
            padding: 8px;
            text-align: left;
        }
        th {
            background-color: #f5f5f5;
        }
        tr:nth-child(even) {
            background-color: #fafafa;
        }
        tr:hover {
            background-color: #f0f0f0;
        }
        """
