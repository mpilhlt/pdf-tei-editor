"""
Inter-Annotator Agreement Analyzer plugin.

This plugin computes inter-annotator agreement between all versions of a TEI
annotation variant for a PDF document by comparing element sequences within
the <text> element.
"""

import logging
from typing import Any, Callable

from lxml import etree

from fastapi_app.lib.plugin_base import Plugin, PluginContext

logger = logging.getLogger(__name__)

# Tags to ignore in element sequence comparison
IGNORE_TAGS = frozenset([
    # Add tags that should be skipped in comparison, e.g., 'pb', 'milestone'
])

# Attributes to ignore in element comparison
IGNORE_ATTRIBUTES = frozenset([
    'xml:id',  # Internal IDs vary between versions
    'xml:base',
    # Add other attributes that should be ignored
])


class IAAAnalyzerPlugin(Plugin):
    """
    Plugin that computes inter-annotator agreement for TEI annotation versions.
    """

    @property
    def metadata(self) -> dict[str, Any]:
        """Return plugin metadata."""
        return {
            "id": "iaa-analyzer",
            "name": "Inter-Annotator Agreement",
            "description": "Compute agreement between annotation versions by comparing element positions in <text>",
            "version": "1.0.0",
            "category": "document",
            "required_roles": ["user"],
            "endpoints": [
                {
                    "name": "compute_agreement",
                    "label": "Compute Inter-Annotator Agreement",
                    "description": "Analyze agreement between all TEI versions for current PDF and variant",
                    "state_params": ["pdf", "variant"],
                },
            ],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        """Return available endpoints."""
        return {
            "compute_agreement": self.compute_agreement,
        }

    async def compute_agreement(
        self, context: PluginContext, params: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Compute inter-annotator agreement for all TEI versions.

        Args:
            context: Plugin context
            params: Parameters including 'pdf' (PDF stable_id or file hash) and 'variant'

        Returns:
            HTML table with pairwise agreement statistics
        """
        pdf_id = params.get("pdf")
        if not pdf_id:
            return {
                "error": "No PDF document selected",
                "html": "<p>Please select a PDF document first.</p>",
            }

        variant_filter = params.get("variant")

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

            # Get all TEI files for this document
            all_files = file_repo.get_files_by_doc_id(doc_id)
            tei_files = [f for f in all_files if f.file_type == "tei"]

            # Filter by variant if specified (and not "all" or empty)
            if variant_filter and variant_filter not in ("all", ""):
                tei_files = [
                    f
                    for f in tei_files
                    if getattr(f, "variant", None) == variant_filter
                ]

            if len(tei_files) < 2:
                return {
                    "html": "<p>Need at least 2 TEI versions to compare. Found {} version(s).</p>".format(
                        len(tei_files)
                    ),
                }

            # Extract metadata and element sequences
            versions = []
            for file_metadata in tei_files:
                try:
                    content_bytes = file_storage.read_file(file_metadata.id, "tei")
                    if not content_bytes:
                        logger.warning(f"Empty content for file {file_metadata.id}")
                        continue

                    xml_content = content_bytes.decode("utf-8")
                    metadata = self._extract_metadata(xml_content, file_metadata)
                    elements = self._extract_element_sequence(xml_content)

                    versions.append(
                        {
                            "file_id": file_metadata.id,
                            "metadata": metadata,
                            "elements": elements,
                        }
                    )
                except Exception as e:
                    logger.error(f"Failed to parse TEI file {file_metadata.id}: {e}")
                    continue

            if len(versions) < 2:
                return {
                    "html": "<p>Need at least 2 valid TEI versions to compare. Found {} valid version(s).</p>".format(
                        len(versions)
                    ),
                }

            # Compute pairwise agreements
            comparisons = self._compute_pairwise_agreements(versions)

            # Generate HTML table with session_id for diff links
            # Session ID is passed via params from the route handler
            session_id = params.get("_session_id", "")
            html = self._generate_html_table(comparisons, session_id)

            # Build export URL
            variant_param = f"&variant={variant_filter}" if variant_filter else ""
            export_url = f"/api/plugins/iaa-analyzer/export?pdf={pdf_id}{variant_param}&session_id={session_id}"

            return {
                "html": html,
                "exportUrl": export_url,
                "pdf": pdf_id,  # Deprecated: kept for backward compatibility
                "variant": variant_filter or "all",
            }

        except Exception as e:
            logger.error(
                f"Failed to analyze inter-annotator agreement for PDF {pdf_id}: {e}"
            )
            return {
                "error": str(e),
                "html": f"<p>Error analyzing inter-annotator agreement: {str(e)}</p>",
            }

    def _extract_metadata(
        self, xml_content: str, file_metadata: Any
    ) -> dict[str, Any]:
        """
        Extract document title and annotator from TEI header.

        Args:
            xml_content: TEI XML content as string
            file_metadata: File metadata object

        Returns:
            Dictionary with title, annotator, annotator_id, and stable_id
        """
        try:
            from fastapi_app.lib.tei_utils import extract_tei_metadata, get_annotator_name

            root = etree.fromstring(xml_content.encode("utf-8"))

            # Use existing utility to extract metadata
            tei_metadata = extract_tei_metadata(root)

            # Get title - prefer edition_title, fallback to title
            title = tei_metadata.get("edition_title") or tei_metadata.get(
                "title", "Untitled"
            )

            # Extract last annotator from revisionDesc
            ns = {"tei": "http://www.tei-c.org/ns/1.0"}
            last_change_elem = root.find(
                ".//tei:revisionDesc/tei:change[last()]", ns
            )
            annotator = "Unknown"
            annotator_id = ""
            if last_change_elem is not None:
                who_attr = last_change_elem.get("who", "")
                annotator_id = who_attr.lstrip("#")
                annotator = get_annotator_name(root, who_attr)

            return {
                "title": title.strip() if title else "Untitled",
                "annotator": annotator.strip() if annotator else "Unknown",
                "annotator_id": annotator_id,
                "stable_id": file_metadata.stable_id,
            }

        except Exception as e:
            logger.error(f"Error extracting metadata: {e}")
            return {
                "title": "Error",
                "annotator": "Unknown",
                "annotator_id": "",
                "stable_id": file_metadata.stable_id,
            }

    def _extract_element_sequence(self, xml_content: str) -> list[dict[str, Any]]:
        """
        Extract flattened sequence of element tokens from <text> element.

        Args:
            xml_content: TEI XML content as string

        Returns:
            List of element tokens with tag, text, tail, and attributes
        """
        try:
            root = etree.fromstring(xml_content.encode("utf-8"))

            ns = {"tei": "http://www.tei-c.org/ns/1.0"}
            text_elem = root.find(".//tei:text", ns)

            if text_elem is None:
                logger.warning("No <text> element found in TEI document")
                return []

            sequence = []
            # Traverse all descendants in document order
            for elem in text_elem.iter():
                if elem == text_elem:
                    continue  # Skip the <text> element itself

                # Skip non-element nodes (comments, processing instructions, etc.)
                if not isinstance(elem.tag, str):
                    continue

                # Extract tag name without namespace
                tag = etree.QName(elem).localname

                # Skip ignored tags
                if tag in IGNORE_TAGS:
                    continue

                # Normalize text and tail
                text = self._normalize_text(elem.text)
                tail = self._normalize_text(elem.tail)

                # Extract ALL attributes except ignored ones
                attrs = {}
                for attr_name, attr_value in elem.attrib.items():
                    # Handle namespaced attributes
                    if '}' in attr_name:
                        # Extract local name from {namespace}localname format
                        ns_uri, local = attr_name.split('}')
                        # Convert to prefix:local format for common namespaces
                        if 'www.w3.org/XML' in ns_uri:
                            full_name = f'xml:{local}'
                        else:
                            full_name = local
                    else:
                        full_name = attr_name

                    # Skip ignored attributes
                    if full_name not in IGNORE_ATTRIBUTES:
                        attrs[full_name] = attr_value

                sequence.append(
                    {"tag": tag, "text": text, "tail": tail, "attrs": attrs}
                )

            return sequence

        except Exception as e:
            logger.error(f"Error extracting element sequence: {e}")
            return []

    def _normalize_text(self, text: str | None) -> str | None:
        """
        Normalize text content: strip, collapse whitespace, return None if empty.

        Args:
            text: Text content to normalize

        Returns:
            Normalized text or None
        """
        if not text:
            return None
        normalized = " ".join(text.split())
        return normalized if normalized else None

    def _compute_pairwise_agreements(
        self, versions: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """
        Compute agreement for all version pairs.

        Args:
            versions: List of version dictionaries with metadata and elements

        Returns:
            List of comparison dictionaries with agreement statistics
        """
        comparisons = []

        for i in range(len(versions)):
            for j in range(i + 1, len(versions)):
                v1 = versions[i]
                v2 = versions[j]

                matches = self._count_matches(v1["elements"], v2["elements"])
                total = max(len(v1["elements"]), len(v2["elements"]))
                agreement = (matches / total * 100) if total > 0 else 0

                comparisons.append(
                    {
                        "version1": v1["metadata"],
                        "version2": v2["metadata"],
                        "matches": matches,
                        "total": total,
                        "v1_count": len(v1["elements"]),
                        "v2_count": len(v2["elements"]),
                        "agreement": round(agreement, 2),
                    }
                )

        return comparisons

    def _count_matches(
        self, seq1: list[dict[str, Any]], seq2: list[dict[str, Any]]
    ) -> int:
        """
        Count matching element tokens at same positions.

        Args:
            seq1: First element sequence
            seq2: Second element sequence

        Returns:
            Number of matching elements
        """
        matches = 0
        min_len = min(len(seq1), len(seq2))

        for i in range(min_len):
            elem1 = seq1[i]
            elem2 = seq2[i]

            # Elements match if tag, text, tail, and relevant attributes all match
            if (
                elem1["tag"] == elem2["tag"]
                and elem1["text"] == elem2["text"]
                and elem1["tail"] == elem2["tail"]
                and elem1["attrs"] == elem2["attrs"]
            ):
                matches += 1

        return matches

    def _generate_html_table(self, comparisons: list[dict[str, Any]], session_id: str) -> str:
        """
        Generate HTML table from comparison results.

        Args:
            comparisons: List of comparison dictionaries
            session_id: Session ID for authentication in diff viewer links

        Returns:
            HTML table as string
        """
        if not comparisons:
            return "<p>No comparisons to display.</p>"

        # Build header row
        header_cells = [
            '<th style="border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 0.9em;">Version 1</th>',
            '<th style="border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 0.9em; width: 120px;">Annotator 1</th>',
            '<th style="border: 1px solid #ddd; padding: 8px; text-align: center; font-size: 0.9em; width: 60px;">Elements</th>',
            '<th style="border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 0.9em;">Version 2</th>',
            '<th style="border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 0.9em; width: 120px;">Annotator 2</th>',
            '<th style="border: 1px solid #ddd; padding: 8px; text-align: center; font-size: 0.9em; width: 60px;">Elements</th>',
            '<th style="border: 1px solid #ddd; padding: 8px; text-align: center; font-size: 0.9em; width: 60px;">Matches</th>',
            '<th style="border: 1px solid #ddd; padding: 8px; text-align: center; font-size: 0.9em; width: 80px;">Agreement</th>',
            '<th style="border: 1px solid #ddd; padding: 8px; text-align: center; font-size: 0.9em; width: 80px;">Details</th>',
        ]

        html_parts = [
            '<table style="width: 100%; border-collapse: collapse; font-size: 0.9em;">',
            "<thead>",
            '<tr style="background-color: #f5f5f5;">',
            *header_cells,
            "</tr>",
            "</thead>",
            "<tbody>",
        ]

        for comp in comparisons:
            v1 = comp["version1"]
            v2 = comp["version2"]

            # Color code agreement percentage
            agreement_pct = comp["agreement"]
            if agreement_pct >= 80:
                color = "#d4edda"  # Green
            elif agreement_pct >= 60:
                color = "#fff3cd"  # Yellow
            else:
                color = "#f8d7da"  # Red

            # Create clickable links for document titles and diff
            v1_title_link = f'<a href="#" onclick="window.pluginSandbox.openDocument(\'{v1["stable_id"]}\'); return false;" style="color: #0066cc; text-decoration: underline;">{self._escape_html(v1["title"])}</a>'
            v2_title_link = f'<a href="#" onclick="window.pluginSandbox.openDocument(\'{v2["stable_id"]}\'); return false;" style="color: #0066cc; text-decoration: underline;">{self._escape_html(v2["title"])}</a>'
            diff_link = f'<a href="#" onclick="window.pluginSandbox.openDiff(\'{v1["stable_id"]}\', \'{v2["stable_id"]}\'); return false;" style="color: #0066cc; text-decoration: underline;">{comp["matches"]}/{comp["total"]}</a>'

            # Create link to standalone diff viewer
            diff_url = f'/api/plugins/iaa-analyzer/diff?stable_id1={v1["stable_id"]}&stable_id2={v2["stable_id"]}&session_id={session_id}'
            view_diff_link = f'<a href="#" onclick="event.preventDefault(); window.pluginSandbox?.openControlledWindow(\'{diff_url}\'); return false;" style="color: #0066cc; text-decoration: underline;">View Diff</a>'

            row_cells = [
                f'<td style="border: 1px solid #ddd; padding: 8px; font-size: 0.9em;">{v1_title_link}</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px; font-size: 0.9em;">{self._escape_html(v1["annotator"])}</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px; text-align: center; font-size: 0.9em;">{comp["v1_count"]}</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px; font-size: 0.9em;">{v2_title_link}</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px; font-size: 0.9em;">{self._escape_html(v2["annotator"])}</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px; text-align: center; font-size: 0.9em;">{comp["v2_count"]}</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px; text-align: center; font-size: 0.9em;">{diff_link}</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px; text-align: center; font-size: 0.9em; background-color: {color};">{agreement_pct}%</td>',
                f'<td style="border: 1px solid #ddd; padding: 8px; text-align: center; font-size: 0.9em;">{view_diff_link}</td>',
            ]

            html_parts.extend(
                [
                    "<tr>",
                    *row_cells,
                    "</tr>",
                ]
            )

        html_parts.extend(
            [
                "</tbody>",
                "</table>",
            ]
        )

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
