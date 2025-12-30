"""
Custom routes for Edit History plugin.
"""

import csv
import io
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import StreamingResponse, HTMLResponse
from lxml import etree

from fastapi_app.lib.dependencies import (
    get_auth_manager,
    get_db,
    get_file_storage,
    get_session_manager,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/edit-history", tags=["edit-history"])


@router.get("/view", response_class=HTMLResponse)
async def view_history(
    collection: str = Query(..., description="Collection ID"),
    variant: str | None = Query(None, description="Variant filter"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """
    View edit history as an HTML page with sortable table.

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

        # Filter to TEI files only
        tei_files = [f for f in all_files if f.file_type == "tei"]

        # Filter by variant if specified
        if variant and variant not in ("all", ""):
            tei_files = [
                f for f in tei_files if getattr(f, "variant", None) == variant
            ]

        # Extract edit history
        history_entries = []
        for file_metadata in tei_files:
            try:
                content_bytes = file_storage.read_file(file_metadata.id, "tei")
                if not content_bytes:
                    continue

                xml_content = content_bytes.decode("utf-8")
                entries = _extract_revision_info(xml_content, file_metadata)
                history_entries.extend(entries)

            except Exception as e:
                logger.error(f"Failed to parse TEI file {file_metadata.id}: {e}")
                continue

        # Sort by date descending
        history_entries.sort(key=lambda x: x["timestamp"], reverse=True)

        # Prepare table data
        headers = ["Change Date", "Document ID", "Extraction Label", "Change Description", "Who"]
        rows = []
        for entry in history_entries:
            # Make extraction label clickable
            doc_link = f'<a href="#" onclick="sandbox.openDocument(\'{entry["stable_id"]}\'); return false;" style="color: #0066cc; text-decoration: underline;">{escape_html(entry["doc_label"])}</a>'

            rows.append([
                escape_html(entry["date_str"]),
                escape_html(entry["doc_id"]),
                doc_link,
                escape_html(entry["description"]),
                escape_html(entry["who"])
            ])

        # Generate HTML page
        title = f"Edit History - {collection}"
        if variant and variant != "all":
            title += f" ({variant})"

        html = generate_datatable_page(
            title=title,
            headers=headers,
            rows=rows,
            table_id="editHistoryTable",
            page_length=25,
            default_sort_col=0,
            default_sort_dir="desc",
            enable_sandbox_client=True,
            custom_css="table { font-size: 0.9em; }"
        )

        return HTMLResponse(content=html)

    except Exception as e:
        logger.error(f"Failed to generate edit history view: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/export")
async def export_csv(
    collection: str = Query(..., description="Collection ID"),
    variant: str | None = Query(None, description="Variant filter"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """
    Export edit history as CSV.

    Args:
        collection: Collection ID to export
        variant: Optional variant filter
        session_id: Session ID from query parameter
        x_session_id: Session ID from header
        session_manager: Session manager dependency
        auth_manager: Auth manager dependency

    Returns:
        CSV file as streaming response
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.file_repository import FileRepository
    from fastapi_app.lib.tei_utils import extract_tei_metadata
    from fastapi_app.lib.user_utils import user_has_collection_access

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
    if not user_has_collection_access(user, collection, settings.db_dir):
        raise HTTPException(status_code=403, detail="Access denied to collection")

    try:
        db = get_db()
        file_repo = FileRepository(db)
        file_storage = get_file_storage()

        # Get all files in the collection
        all_files = file_repo.get_files_by_collection(collection)

        # Filter to TEI files only
        tei_files = [f for f in all_files if f.file_type == "tei"]

        # Filter by variant if specified
        if variant and variant not in ("all", ""):
            tei_files = [
                f for f in tei_files if getattr(f, "variant", None) == variant
            ]

        # Extract edit history
        history_entries = []
        for file_metadata in tei_files:
            try:
                content_bytes = file_storage.read_file(file_metadata.id, "tei")
                if not content_bytes:
                    continue

                xml_content = content_bytes.decode("utf-8")
                entries = _extract_revision_info(xml_content, file_metadata)
                history_entries.extend(entries)

            except Exception as e:
                logger.error(f"Failed to parse TEI file {file_metadata.id}: {e}")
                continue

        # Sort by date descending
        history_entries.sort(key=lambda x: x["timestamp"], reverse=True)

        # Generate CSV
        output = io.StringIO()
        writer = csv.writer(output)

        # Write header
        writer.writerow(
            ["Change Date", "Document ID", "Extraction Label", "Change Description", "Annotator ID", "Annotator Name"]
        )

        # Write data
        for entry in history_entries:
            writer.writerow(
                [
                    entry["date_str"],
                    entry["doc_id"],
                    entry["doc_label"],
                    entry["description"],
                    entry.get("who_id", ""),
                    entry["who"],
                ]
            )

        # Create streaming response
        output.seek(0)
        return StreamingResponse(
            io.BytesIO(output.getvalue().encode("utf-8")),
            media_type="text/csv",
            headers={
                "Content-Disposition": f'attachment; filename="edit-history-{collection}.csv"'
            },
        )

    except Exception as e:
        logger.error(f"Failed to export edit history: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _extract_revision_info(xml_content: str, file_metadata) -> list[dict]:
    """
    Extract revision information from TEI document.

    Args:
        xml_content: TEI XML content as string
        file_metadata: File metadata object

    Returns:
        List of revision entries
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
        who_attr = last_change.get("who", "")
        who_id = who_attr.lstrip("#")

        # Look up full name from respStmt using @xml:id
        who_name = get_annotator_name(root, who_attr)

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
            timestamp = datetime.fromisoformat(when.replace("Z", "+00:00"))
            # Remove timezone info for consistent comparison
            if timestamp.tzinfo is not None:
                timestamp = timestamp.replace(tzinfo=None)
        except (ValueError, AttributeError):
            timestamp = datetime.now()

        # Get doc_id from file metadata
        doc_id = file_metadata.doc_id or "Unknown"

        return [
            {
                "timestamp": timestamp,
                "date_str": timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                "doc_id": doc_id,
                "doc_label": doc_label,
                "description": description,
                "who_id": who_id,
                "who": who_name,
                "stable_id": file_metadata.stable_id,
            }
        ]

    except Exception as e:
        logger.error(f"Error extracting revision info: {e}")
        return []
