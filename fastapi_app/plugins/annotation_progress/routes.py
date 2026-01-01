"""
Custom routes for Annotation Progress plugin.
"""

import logging
from collections import defaultdict

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import HTMLResponse
from lxml import etree

from fastapi_app.lib.dependencies import (
    get_auth_manager,
    get_db,
    get_file_storage,
    get_session_manager,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/annotation-progress", tags=["annotation-progress"])


@router.get("/view", response_class=HTMLResponse)
async def view_progress(
    collection: str = Query(..., description="Collection ID"),
    variant: str | None = Query(None, description="Variant filter"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """
    View annotation progress as an HTML page with sortable table.

    Args:
        collection: Collection ID to view
        variant: Optional variant filter
        session_id: Session ID from query parameter
        x_session_id: Session ID from header
        session_manager: Session manager dependency
        auth_manager: Auth manager dependency

    Returns:
        HTML page with DataTables-powered table
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.file_repository import FileRepository
    from fastapi_app.lib.plugin_tools import generate_datatable_page, escape_html

    # Extract session ID (header takes precedence)
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

    # Check collection access
    from fastapi_app.lib.user_utils import user_has_collection_access
    if not user_has_collection_access(user, collection, settings.db_dir):
        raise HTTPException(status_code=403, detail="Access denied to collection")

    try:
        db = get_db()
        file_repo = FileRepository(db)
        file_storage = get_file_storage()

        # Get all files in the collection
        all_files = file_repo.get_files_by_collection(collection)

        # Get all unique doc_ids from the collection (from PDF and TEI files)
        all_doc_ids = set()
        for f in all_files:
            if f.doc_id:
                all_doc_ids.add(f.doc_id)

        # Filter to TEI files only
        tei_files = [f for f in all_files if f.file_type == "tei"]

        # Filter by variant if specified
        if variant and variant not in ("all", ""):
            tei_files = [
                f for f in tei_files if getattr(f, "variant", None) == variant
            ]

        # Group annotations by doc_id
        doc_annotations = defaultdict(list)
        for file_metadata in tei_files:
            try:
                content_bytes = file_storage.read_file(file_metadata.id, "tei")
                if not content_bytes:
                    continue

                xml_content = content_bytes.decode("utf-8")
                annotation_info = _extract_annotation_info(xml_content, file_metadata)

                if annotation_info:
                    doc_id = file_metadata.doc_id or "Unknown"
                    doc_annotations[doc_id].append(annotation_info)

            except Exception as e:
                logger.error(f"Failed to parse TEI file {file_metadata.id}: {e}")
                continue

        # Prepare table data
        headers = ["Document ID", "Annotations"]
        rows = []

        # Sort by doc_id and include all documents even if they have no annotations
        for doc_id in sorted(all_doc_ids):
            annotations = doc_annotations[doc_id]

            # Create annotation links with revision counts
            annotation_links = []
            for ann in annotations:
                label = ann["annotation_label"]
                count = ann["revision_count"]
                stable_id = ann["stable_id"]

                link = f'<a href="#" onclick="sandbox.openDocument(\'{stable_id}\'); return false;" style="color: #0066cc; text-decoration: underline;">{escape_html(label)} ({count})</a>'
                annotation_links.append(link)

            annotations_cell = ", ".join(annotation_links) if annotation_links else "No annotations"

            rows.append([
                escape_html(doc_id),
                annotations_cell
            ])

        # Generate HTML page
        title = f"Annotation Progress - {collection}"
        if variant and variant != "all":
            title += f" ({variant})"

        html = generate_datatable_page(
            title=title,
            headers=headers,
            rows=rows,
            table_id="annotationProgressTable",
            page_length=25,
            default_sort_col=0,
            default_sort_dir="asc",
            enable_sandbox_client=True,
            custom_css="table { font-size: 0.9em; }"
        )

        return HTMLResponse(content=html)

    except Exception as e:
        logger.error(f"Failed to generate annotation progress view: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _extract_annotation_info(xml_content: str, file_metadata) -> dict | None:
    """
    Extract annotation information from TEI document.

    Args:
        xml_content: TEI XML content as string
        file_metadata: File metadata object

    Returns:
        Dictionary with annotation label and revision count
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
