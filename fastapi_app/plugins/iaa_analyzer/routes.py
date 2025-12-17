"""
Custom routes for Inter-Annotator Agreement Analyzer plugin.
"""

import copy
import csv
import json
import logging
from io import StringIO
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from lxml import etree

from fastapi_app.lib.dependencies import (
    get_auth_manager,
    get_db,
    get_file_storage,
    get_session_manager,
)
from fastapi_app.lib.file_repository import FileRepository

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/plugins/iaa-analyzer", tags=["plugins"]
)

# Load diff viewer assets
_PLUGIN_DIR = Path(__file__).parent
_DIFF_VIEWER_JS = (_PLUGIN_DIR / "diff-viewer.js").read_text(encoding="utf-8")
_DIFF_VIEWER_CSS = (_PLUGIN_DIR / "diff-viewer.css").read_text(encoding="utf-8")


@router.get("/export")
async def export_csv(
    pdf: str = Query(..., description="PDF stable_id or file hash"),
    variant: str = Query("all", description="Model variant filter"),
):
    """
    Export inter-annotator agreement results as CSV file.

    Args:
        pdf: PDF stable_id or file hash
        variant: Model variant filter (or 'all')

    Returns:
        CSV file download
    """
    from fastapi_app.plugins.iaa_analyzer.plugin import IAAAnalyzerPlugin

    try:
        db = get_db()
        file_repo = FileRepository(db)
        file_storage = get_file_storage()

        # Get doc_id from the PDF's stable_id or file hash
        doc_id = file_repo.get_doc_id_by_file_id(pdf)
        if not doc_id:
            raise HTTPException(status_code=404, detail="PDF file not found")

        # Get all TEI files for this document
        all_files = file_repo.get_files_by_doc_id(doc_id)
        tei_files = [f for f in all_files if f.file_type == "tei"]

        # Filter by variant if specified (and not "all" or empty)
        if variant and variant not in ("all", ""):
            tei_files = [
                f for f in tei_files if getattr(f, "variant", None) == variant
            ]

        if len(tei_files) < 2:
            raise HTTPException(
                status_code=404,
                detail=f"Need at least 2 TEI versions to compare. Found {len(tei_files)} version(s).",
            )

        # Reuse plugin methods to extract data
        plugin = IAAAnalyzerPlugin()
        versions = []

        for file_metadata in tei_files:
            try:
                content_bytes = file_storage.read_file(file_metadata.id, "tei")
                if not content_bytes:
                    logger.warning(f"Empty content for file {file_metadata.id}")
                    continue

                xml_content = content_bytes.decode("utf-8")
                metadata = plugin._extract_metadata(xml_content, file_metadata)
                elements = plugin._extract_element_sequence(xml_content)

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
            raise HTTPException(
                status_code=404,
                detail=f"Need at least 2 valid TEI versions to compare. Found {len(versions)} valid version(s).",
            )

        # Compute pairwise agreements
        comparisons = plugin._compute_pairwise_agreements(versions)

        # Generate CSV
        output = StringIO()
        writer = csv.writer(output)

        # Write header
        header = [
            "Version 1",
            "Stable ID 1",
            "Annotator 1",
            "Elements 1",
            "Version 2",
            "Stable ID 2",
            "Annotator 2",
            "Elements 2",
            "Matches",
            "Total",
            "Agreement (%)",
        ]
        writer.writerow(header)

        # Write data rows
        for comp in comparisons:
            v1 = comp["version1"]
            v2 = comp["version2"]
            row = [
                v1["title"],
                v1["stable_id"],
                v1["annotator"],
                comp["v1_count"],
                v2["title"],
                v2["stable_id"],
                v2["annotator"],
                comp["v2_count"],
                comp["matches"],
                comp["total"],
                comp["agreement"],
            ]
            writer.writerow(row)

        # Get CSV content
        csv_content = output.getvalue()
        output.close()

        # Generate filename
        filename = f"iaa_agreement_{pdf[:8]}.csv"

        # Return StreamingResponse for file download
        return StreamingResponse(
            iter([csv_content]),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(
            f"Failed to export inter-annotator agreement for PDF {pdf}: {e}"
        )
        raise HTTPException(status_code=500, detail=str(e))


def _preprocess_for_diff(
    elem: etree._Element, ignore_tags: frozenset, ignore_attrs: frozenset
) -> etree._Element:
    """
    Create a copy of element tree with ignored tags removed, ignored attributes stripped,
    and text content whitespace normalized.

    Args:
        elem: Root element to preprocess
        ignore_tags: Set of tag names to remove
        ignore_attrs: Set of attribute names to remove

    Returns:
        Preprocessed copy of element tree
    """
    # Deep copy to avoid modifying original
    elem_copy = copy.deepcopy(elem)

    # Remove ignored tags
    for tag_name in ignore_tags:
        for ignored_elem in elem_copy.xpath(f'.//*[local-name()="{tag_name}"]'):
            parent = ignored_elem.getparent()
            if parent is not None:
                parent.remove(ignored_elem)

    # Strip ignored attributes and normalize text content
    for el in elem_copy.iter():
        if not isinstance(el.tag, str):
            continue

        # Normalize text content (collapse whitespace)
        if el.text:
            normalized = " ".join(el.text.split())
            el.text = normalized if normalized else None

        # Normalize tail content (text after element)
        if el.tail:
            normalized = " ".join(el.tail.split())
            el.tail = normalized if normalized else None

        # Strip ignored attributes
        for attr_name in list(el.attrib.keys()):
            # Handle namespaced attributes
            if "}" in attr_name:
                ns_uri, local = attr_name.split("}")
                # Convert to prefix:local format for common namespaces
                if "www.w3.org/XML" in ns_uri:
                    full_name = f"xml:{local}"
                else:
                    full_name = local
            else:
                full_name = attr_name

            if full_name in ignore_attrs:
                del el.attrib[attr_name]

    return elem_copy


def _compute_line_mapping(original_xml: str, preprocessed_xml: str) -> dict[int, int]:
    """
    Compute mapping from preprocessed line numbers to original line numbers.

    This uses a simple heuristic: match lines by their text content after
    stripping whitespace. This works because preprocessing mainly removes
    attributes and normalizes whitespace, not content.

    Args:
        original_xml: Original XML string
        preprocessed_xml: Preprocessed XML string

    Returns:
        Dictionary mapping preprocessed line number (1-indexed) to original line number (1-indexed)
    """
    original_lines = original_xml.split('\n')
    preprocessed_lines = preprocessed_xml.split('\n')

    # Normalize lines for comparison (strip whitespace and common formatting)
    def normalize_for_comparison(line: str) -> str:
        return ''.join(line.split()).lower()

    original_normalized = [normalize_for_comparison(line) for line in original_lines]

    line_mapping = {}
    original_idx = 0

    for prep_idx, prep_line in enumerate(preprocessed_lines):
        prep_normalized = normalize_for_comparison(prep_line)

        # Search forward in original lines for a match
        while original_idx < len(original_lines):
            if original_normalized[original_idx] == prep_normalized:
                line_mapping[prep_idx + 1] = original_idx + 1  # 1-indexed
                original_idx += 1
                break
            original_idx += 1
        else:
            # No match found - use best guess (current position)
            if original_idx < len(original_lines):
                line_mapping[prep_idx + 1] = original_idx + 1

    return line_mapping


def _escape_html(text: str) -> str:
    """Escape HTML special characters."""
    if not text:
        return ""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#x27;")
    )


def _generate_diff_html(
    title1: str,
    title2: str,
    xml1_original: str,
    xml2_original: str,
    xml1_preprocessed: str,
    xml2_preprocessed: str,
    line_mapping1: dict[int, int],
    line_mapping2: dict[int, int],
    line_offset1: int,
    line_offset2: int,
    stable_id1: str,
    stable_id2: str,
) -> str:
    """Generate standalone HTML page with side-by-side XML diff showing only differences.

    Args:
        title1: Title of first document
        title2: Title of second document
        xml1_original: Original XML of first document (for display)
        xml2_original: Original XML of second document (for display)
        xml1_preprocessed: Preprocessed XML of first document (for diff computation)
        xml2_preprocessed: Preprocessed XML of second document (for diff computation)
        line_mapping1: Mapping from preprocessed line numbers to original line numbers (doc 1)
        line_mapping2: Mapping from preprocessed line numbers to original line numbers (doc 2)
        line_offset1: Line number offset of content element in full document 1
        line_offset2: Line number offset of content element in full document 2
        stable_id1: Stable ID of first document
        stable_id2: Stable ID of second document

    Returns:
        HTML string with embedded diff viewer
    """
    from fastapi_app.lib.plugin_tools import generate_sandbox_client_script

    # Escape XML for embedding in JavaScript
    xml1_original_escaped = json.dumps(xml1_original)
    xml2_original_escaped = json.dumps(xml2_original)
    xml1_preprocessed_escaped = json.dumps(xml1_preprocessed)
    xml2_preprocessed_escaped = json.dumps(xml2_preprocessed)
    line_mapping1_escaped = json.dumps(line_mapping1)
    line_mapping2_escaped = json.dumps(line_mapping2)

    # Get sandbox client script
    sandbox_script = generate_sandbox_client_script()

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>XML Diff: {_escape_html(title1)} vs {_escape_html(title2)}</title>

    <!-- Sandbox client for parent window communication -->
    <script>{sandbox_script}</script>

    <!-- Load diff library from CDN -->
    <script src="https://cdn.jsdelivr.net/npm/diff@5.2.0/dist/diff.min.js"></script>

    <!-- Load Prism.js for syntax highlighting -->
    <link href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism.min.css" rel="stylesheet" />
    <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-markup.min.js"></script>

    <!-- Diff viewer styles -->
    <style>
{_DIFF_VIEWER_CSS}
    </style>
</head>
<body>
    <div class="header">
        <h1>TEI XML Comparison - Differences Only</h1>
        <div class="titles">
            <span>{_escape_html(title1)}</span>
            <span>{_escape_html(title2)}</span>
        </div>
        <div class="controls">
            <span class="toggle-label">Show all differences</span>
            <label class="toggle-switch">
                <input type="checkbox" id="semanticToggle">
                <span class="toggle-slider"></span>
            </label>
            <span class="toggle-label">Show semantic differences only</span>
        </div>
        <div class="summary" id="summary"></div>
    </div>

    <div id="diffResults"></div>

    <!-- Diff viewer logic -->
    <script>
{_DIFF_VIEWER_JS}
    </script>

    <!-- Initialize diff viewer with data -->
    <script>
        initDiffViewer({{
            xml1Original: {xml1_original_escaped},
            xml2Original: {xml2_original_escaped},
            xml1Preprocessed: {xml1_preprocessed_escaped},
            xml2Preprocessed: {xml2_preprocessed_escaped},
            lineMapping1: {line_mapping1_escaped},
            lineMapping2: {line_mapping2_escaped},
            lineOffset1: {line_offset1},
            lineOffset2: {line_offset2},
            stableId1: {json.dumps(stable_id1)},
            stableId2: {json.dumps(stable_id2)}
        }});
    </script>
</body>
</html>
    """


@router.get("/diff")
async def show_diff(
    stable_id1: str = Query(..., description="First document stable ID"),
    stable_id2: str = Query(..., description="Second document stable ID"),
    content_xpath: str = Query(".//tei:text", description="XPath to content element to compare"),
    session_id: str | None = Query(None, description="Session ID for authentication"),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    db=Depends(get_db),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """
    Render standalone side-by-side XML diff page showing only differences.

    Args:
        stable_id1: First document stable ID
        stable_id2: Second document stable ID
        content_xpath: XPath expression to select content element (default: ".//tei:text")
        session_id: Session ID for authentication (query param fallback)
        x_session_id: Session ID from header
        db: Database session
        session_manager: Session manager dependency
        auth_manager: Auth manager dependency

    Returns:
        HTML page with diff viewer
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.tei_utils import extract_tei_metadata
    from fastapi_app.plugins.iaa_analyzer.plugin import (
        IGNORE_ATTRIBUTES,
        IGNORE_TAGS,
    )

    # Authenticate
    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    # Validate session
    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    # Get user
    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # Fetch both documents
    file_repo = FileRepository(db)
    file_storage = get_file_storage()

    file1 = file_repo.get_file_by_stable_id(stable_id1)
    file2 = file_repo.get_file_by_stable_id(stable_id2)

    if not file1 or not file2:
        raise HTTPException(status_code=404, detail="One or both documents not found")

    # Check user access to documents via collections
    from fastapi_app.lib.user_utils import user_has_collection_access

    user_has_access_to_file1 = False
    user_has_access_to_file2 = False

    for collection_id in file1.doc_collections or []:
        if user_has_collection_access(user, collection_id, settings.db_dir):
            user_has_access_to_file1 = True
            break

    for collection_id in file2.doc_collections or []:
        if user_has_collection_access(user, collection_id, settings.db_dir):
            user_has_access_to_file2 = True
            break

    if not user_has_access_to_file1 or not user_has_access_to_file2:
        raise HTTPException(status_code=403, detail="Access denied to one or both documents")

    # Read XML content
    try:
        xml1 = file_storage.read_file(file1.id, "tei").decode("utf-8")
        xml2 = file_storage.read_file(file2.id, "tei").decode("utf-8")
    except Exception as e:
        logger.error(f"Failed to read TEI files: {e}")
        raise HTTPException(status_code=500, detail="Failed to read TEI files")

    # Extract metadata for headers
    try:
        root1 = etree.fromstring(xml1.encode("utf-8"))
        root2 = etree.fromstring(xml2.encode("utf-8"))

        meta1 = extract_tei_metadata(root1)
        meta2 = extract_tei_metadata(root2)

        title1 = meta1.get("edition_title") or meta1.get("title", "Document 1")
        title2 = meta2.get("edition_title") or meta2.get("title", "Document 2")
    except Exception as e:
        logger.error(f"Failed to extract metadata: {e}")
        title1 = "Document 1"
        title2 = "Document 2"

    # Extract content element for comparison using XPath
    try:
        ns = {"tei": "http://www.tei-c.org/ns/1.0"}

        # Use the provided XPath to find content elements
        content1_elem = root1.find(content_xpath, ns)
        content2_elem = root2.find(content_xpath, ns)

        if content1_elem is None or content2_elem is None:
            raise HTTPException(
                status_code=400,
                detail=f"One or both documents missing element at XPath: {content_xpath}"
            )

        # Find line offset of content element in full document
        def find_element_line_offset(full_xml: str, elem: etree._Element) -> int:
            """
            Find the line number where the element starts in the full document (1-indexed).
            Uses sourceline if available, otherwise searches for the tag.
            """
            if hasattr(elem, 'sourceline') and elem.sourceline:
                return elem.sourceline

            # Fallback: search for opening tag in full XML
            tag_name = elem.tag.split('}')[-1] if '}' in elem.tag else elem.tag
            lines = full_xml.split('\n')
            for i, line in enumerate(lines):
                if f'<{tag_name}' in line or f'<tei:{tag_name}' in line:
                    return i + 1
            return 1  # Fallback to line 1 if not found

        content1_line_offset = find_element_line_offset(xml1, content1_elem)
        content2_line_offset = find_element_line_offset(xml2, content2_elem)

        # Serialize original content (for line numbers and navigation)
        content1_xml_original = etree.tostring(
            content1_elem, encoding="unicode", pretty_print=True
        )
        content2_xml_original = etree.tostring(
            content2_elem, encoding="unicode", pretty_print=True
        )

        # Preprocess: remove ignored elements and attributes
        content1_preprocessed = _preprocess_for_diff(
            content1_elem, IGNORE_TAGS, IGNORE_ATTRIBUTES
        )
        content2_preprocessed = _preprocess_for_diff(
            content2_elem, IGNORE_TAGS, IGNORE_ATTRIBUTES
        )

        # Serialize preprocessed content (for diff computation)
        content1_xml_preprocessed = etree.tostring(
            content1_preprocessed, encoding="unicode", pretty_print=True
        )
        content2_xml_preprocessed = etree.tostring(
            content2_preprocessed, encoding="unicode", pretty_print=True
        )

        # Compute line mappings from preprocessed to original (within extracted content)
        line_mapping1 = _compute_line_mapping(content1_xml_original, content1_xml_preprocessed)
        line_mapping2 = _compute_line_mapping(content2_xml_original, content2_xml_preprocessed)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to process XML for diff: {e}")
        raise HTTPException(status_code=500, detail="Failed to process XML for diff")

    # Render HTML page with embedded XML
    html = _generate_diff_html(
        title1, title2,
        content1_xml_original, content2_xml_original,
        content1_xml_preprocessed, content2_xml_preprocessed,
        line_mapping1, line_mapping2,
        content1_line_offset, content2_line_offset,
        stable_id1, stable_id2
    )

    return Response(content=html, media_type="text/html")
