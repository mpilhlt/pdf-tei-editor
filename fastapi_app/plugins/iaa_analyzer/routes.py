"""
Custom routes for Inter-Annotator Agreement Analyzer plugin.
"""

import copy
import csv
import json
import logging
from io import StringIO

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


def _generate_diff_html(title1: str, title2: str, xml1: str, xml2: str, stable_id1: str, stable_id2: str) -> str:
    """Generate standalone HTML page with side-by-side XML diff showing only differences."""
    from fastapi_app.lib.plugin_tools import generate_sandbox_client_script

    # Escape XML for embedding in JavaScript
    xml1_escaped = json.dumps(xml1)
    xml2_escaped = json.dumps(xml2)

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

    <style>
        * {{
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }}

        body {{
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #f5f5f5;
            padding: 20px;
        }}

        .header {{
            background: white;
            padding: 20px;
            margin-bottom: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }}

        .header h1 {{
            font-size: 24px;
            margin-bottom: 10px;
            color: #333;
        }}

        .header .titles {{
            display: flex;
            justify-content: space-between;
            color: #666;
            font-size: 14px;
        }}

        .header .summary {{
            margin-top: 10px;
            padding: 10px;
            background: #f8f9fa;
            border-radius: 4px;
            font-size: 13px;
            color: #495057;
        }}

        .diff-block {{
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            margin-bottom: 20px;
            overflow: hidden;
        }}

        .diff-block-header {{
            background: #f8f9fa;
            padding: 8px 16px;
            border-bottom: 1px solid #dee2e6;
            font-size: 12px;
            color: #6c757d;
            font-weight: 600;
        }}

        .diff-container {{
            display: flex;
        }}

        .diff-pane {{
            flex: 1;
            padding: 16px;
            font-family: 'Monaco', 'Courier New', monospace;
            font-size: 13px;
            line-height: 1.6;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-x: auto;
        }}

        .diff-pane:first-child {{
            border-right: 2px solid #dee2e6;
        }}

        .diff-line {{
            display: flex;
            cursor: pointer;
            transition: background-color 0.15s;
        }}

        .diff-line:hover {{
            background-color: rgba(0, 0, 0, 0.05) !important;
        }}

        .diff-line:active {{
            background-color: rgba(0, 0, 0, 0.1) !important;
        }}

        .line-number {{
            color: #999;
            text-align: right;
            padding-right: 12px;
            min-width: 50px;
            user-select: none;
            flex-shrink: 0;
        }}

        .line-content {{
            flex: 1;
        }}

        /* Syntax highlighting overrides for Prism */
        .line-content code[class*="language-"] {{
            background: transparent;
            padding: 0;
            margin: 0;
            font-size: inherit;
            line-height: inherit;
            white-space: pre-wrap;
            word-wrap: break-word;
        }}

        /* Diff highlighting - must override Prism colors */
        .diff-added {{
            background-color: #d4edda !important;
        }}

        .diff-removed {{
            background-color: #f8d7da !important;
        }}

        .diff-modified {{
            background-color: #fff3cd !important;
        }}

        /* Ensure Prism tokens are visible on colored backgrounds */
        .diff-added .token,
        .diff-removed .token {{
            background: transparent !important;
        }}

        /* Inline diff highlighting */
        .inline-added {{
            background-color: #acf2bd;
            padding: 2px 0;
        }}

        .inline-removed {{
            background-color: #fdb8c0;
            padding: 2px 0;
        }}

        /* Ellipsis marker for cropped content */
        .ellipsis {{
            color: #999;
            font-style: italic;
            background: #f0f0f0;
            padding: 0 4px;
            margin: 0 2px;
            border-radius: 2px;
            font-size: 11px;
            user-select: none;
        }}

        .empty-message {{
            text-align: center;
            padding: 40px;
            color: #6c757d;
            font-style: italic;
        }}
    </style>
</head>
<body>
    <div class="header">
        <h1>TEI XML Comparison - Differences Only</h1>
        <div class="titles">
            <span>{_escape_html(title1)}</span>
            <span>{_escape_html(title2)}</span>
        </div>
        <div class="summary" id="summary"></div>
    </div>

    <div id="diffResults"></div>

    <script>
        // XML content
        const xml1 = {xml1_escaped};
        const xml2 = {xml2_escaped};
        const stableId1 = {json.dumps(stable_id1)};
        const stableId2 = {json.dumps(stable_id2)};

        // Apply syntax highlighting to a line of XML
        function highlightXml(line) {{
            if (!line) return '';
            // Use Prism to highlight XML (markup language)
            return Prism.highlight(line, Prism.languages.markup, 'markup');
        }}

        // Crop identical content within a line, keeping context around differences
        function cropLine(line, isChanged) {{
            if (!isChanged || line.length < 80) {{
                return highlightXml(line);
            }}

            // For changed lines, show start and end with ellipsis in middle if very long
            const start = line.substring(0, 40);
            const end = line.substring(line.length - 40);

            return highlightXml(start) + '<span class="ellipsis">&lt;⋯&gt;</span>' + highlightXml(end);
        }}

        // HTML escape (not needed anymore since Prism handles it)
        function escapeHtml(text) {{
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }}

        // Add click handler to diff line
        function addClickHandler(lineDiv, stableId, lineNumber) {{
            lineDiv.addEventListener('click', async () => {{
                if (!window.sandbox) {{
                    alert('Sandbox API not available - open this page via plugin');
                    return;
                }}

                try {{
                    await window.sandbox.openDocumentAtLine(stableId, lineNumber, 0);
                }} catch (error) {{
                    console.error('Failed to open document:', error);
                    alert('Failed to open document: ' + error.message);
                }}
            }});

            // Add title attribute for hint
            lineDiv.title = 'Click to open document at line ' + lineNumber;
        }}

        // Compute and render only differences
        function computeAndRenderDiffs() {{
            const lines1 = xml1.split('\\n');
            const lines2 = xml2.split('\\n');

            // Compute line-level diff
            const diff = Diff.diffLines(xml1, xml2);

            let diffBlocks = [];
            let line1 = 1;
            let line2 = 1;
            let blockCount = 0;

            diff.forEach(part => {{
                const lines = part.value.split('\\n').filter((l, i, arr) => {{
                    // Keep empty lines except the last one (from split)
                    return i < arr.length - 1 || l !== '';
                }});

                if (part.added || part.removed) {{
                    // Found a difference - create diff block
                    if (!diffBlocks.length || diffBlocks[diffBlocks.length - 1].closed) {{
                        diffBlocks.push({{
                            left: [],
                            right: [],
                            startLine1: line1,
                            startLine2: line2,
                            closed: false
                        }});
                        blockCount++;
                    }}

                    const currentBlock = diffBlocks[diffBlocks.length - 1];

                    if (part.removed) {{
                        lines.forEach((line, i) => {{
                            currentBlock.left.push({{
                                number: line1 + i,
                                content: line,
                                type: 'removed'
                            }});
                        }});
                        line1 += lines.length;
                    }} else if (part.added) {{
                        lines.forEach((line, i) => {{
                            currentBlock.right.push({{
                                number: line2 + i,
                                content: line,
                                type: 'added'
                            }});
                        }});
                        line2 += lines.length;
                    }}
                }} else {{
                    // Unchanged section - skip it, but advance line counters
                    line1 += lines.length;
                    line2 += lines.length;

                    // Close current diff block if any
                    if (diffBlocks.length && !diffBlocks[diffBlocks.length - 1].closed) {{
                        diffBlocks[diffBlocks.length - 1].closed = true;
                    }}
                }}
            }});

            // Render summary
            const summary = document.getElementById('summary');
            if (diffBlocks.length === 0) {{
                summary.textContent = 'No differences found.';
                document.getElementById('diffResults').innerHTML =
                    '<div class="empty-message">The documents are identical.</div>';
                return;
            }}

            summary.textContent = `Found ${{diffBlocks.length}} difference block(s)`;

            // Render diff blocks
            const resultsContainer = document.getElementById('diffResults');
            diffBlocks.forEach((block, idx) => {{
                const blockDiv = document.createElement('div');
                blockDiv.className = 'diff-block';

                const header = document.createElement('div');
                header.className = 'diff-block-header';
                header.textContent = `Difference #${{idx + 1}} - Lines ${{block.startLine1}} ↔ ${{block.startLine2}}`;
                blockDiv.appendChild(header);

                const container = document.createElement('div');
                container.className = 'diff-container';

                // Left pane
                const leftPane = document.createElement('div');
                leftPane.className = 'diff-pane';
                block.left.forEach(item => {{
                    const lineDiv = document.createElement('div');
                    lineDiv.className = 'diff-line diff-' + item.type;
                    lineDiv.innerHTML = `<span class="line-number">${{item.number}}</span><span class="line-content">${{cropLine(item.content, true)}}</span>`;

                    // Add click handler
                    addClickHandler(lineDiv, stableId1, item.number);

                    leftPane.appendChild(lineDiv);
                }});
                container.appendChild(leftPane);

                // Right pane
                const rightPane = document.createElement('div');
                rightPane.className = 'diff-pane';
                block.right.forEach(item => {{
                    const lineDiv = document.createElement('div');
                    lineDiv.className = 'diff-line diff-' + item.type;
                    lineDiv.innerHTML = `<span class="line-number">${{item.number}}</span><span class="line-content">${{cropLine(item.content, true)}}</span>`;

                    // Add click handler
                    addClickHandler(lineDiv, stableId2, item.number);

                    rightPane.appendChild(lineDiv);
                }});
                container.appendChild(rightPane);

                blockDiv.appendChild(container);
                resultsContainer.appendChild(blockDiv);
            }});
        }}

        // Initialize
        computeAndRenderDiffs();
    </script>
</body>
</html>
    """


@router.get("/diff")
async def show_diff(
    stable_id1: str = Query(..., description="First document stable ID"),
    stable_id2: str = Query(..., description="Second document stable ID"),
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

    # Extract <text> element content for comparison
    try:
        ns = {"tei": "http://www.tei-c.org/ns/1.0"}
        text1_elem = root1.find(".//tei:text", ns)
        text2_elem = root2.find(".//tei:text", ns)

        if text1_elem is None or text2_elem is None:
            raise HTTPException(
                status_code=400, detail="Documents missing <text> element"
            )

        # Preprocess: remove ignored elements and attributes
        text1_preprocessed = _preprocess_for_diff(
            text1_elem, IGNORE_TAGS, IGNORE_ATTRIBUTES
        )
        text2_preprocessed = _preprocess_for_diff(
            text2_elem, IGNORE_TAGS, IGNORE_ATTRIBUTES
        )

        # Serialize preprocessed content (pretty-printed)
        text1_xml = etree.tostring(
            text1_preprocessed, encoding="unicode", pretty_print=True
        )
        text2_xml = etree.tostring(
            text2_preprocessed, encoding="unicode", pretty_print=True
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to process XML for diff: {e}")
        raise HTTPException(status_code=500, detail="Failed to process XML for diff")

    # Render HTML page with embedded XML
    html = _generate_diff_html(title1, title2, text1_xml, text2_xml, stable_id1, stable_id2)

    return Response(content=html, media_type="text/html")
