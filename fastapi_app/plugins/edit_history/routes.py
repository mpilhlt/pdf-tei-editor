"""
Custom routes for Edit History plugin.
"""

import csv
import io
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import StreamingResponse, HTMLResponse
from lxml import etree

from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_db,
    get_file_repository,
    get_file_storage,
    get_session_manager,
    require_authenticated_user,
)
from fastapi_app.lib.models import FileMetadata
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage

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
    from fastapi_app.lib.repository.file_repository import FileRepository
    from fastapi_app.lib.plugins.plugin_tools import generate_datatable_page, escape_html

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
    from fastapi_app.lib.permissions.user_utils import user_has_collection_access
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
        headers = ["Change Date", "Document ID", "Annotation Label", "Change Description", "Who", "Status"]
        rows = []
        for entry in history_entries:
            # Make annotation label clickable
            doc_link = f'<a href="#" onclick="sandbox.openDocument(\'{entry["stable_id"]}\'); return false;" style="color: #0066cc; text-decoration: underline;">{escape_html(entry["doc_label"])}</a>'

            rows.append([
                escape_html(entry["date_str"]),
                escape_html(entry["doc_id"]),
                doc_link,
                escape_html(entry["description"]),
                escape_html(entry["who"]),
                escape_html(entry.get("status", ""))
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
    from fastapi_app.lib.repository.file_repository import FileRepository
    from fastapi_app.lib.permissions.user_utils import user_has_collection_access

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
            ["Change Date", "Document ID", "Annotation Label", "Change Description", "Annotator ID", "Annotator Name", "Status"]
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
                    entry.get("status", ""),
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


# The dashboard box reads the changes of `limit * RECENT_FILES_FACTOR` most recently updated TEI files
RECENT_FILES_FACTOR = 2


def _accessible_tei_files(user: dict[str, Any], file_repo: FileRepository, db_dir: Path) -> list[FileMetadata]:
    """TEI files in the collections of the non-archived projects the user can access, newest first.

    Admins (`*` role) can access all projects. Files whose collections all belong only to
    archived projects are left out.
    """
    from fastapi_app.lib.utils.project_utils import get_archived_collection_ids, get_visible_projects

    archived = get_archived_collection_ids(db_dir)
    collections = {c for p in get_visible_projects(user, db_dir) for c in p.get("collections", [])}
    if "*" in collections:
        candidates = file_repo.list_files(file_type="tei")
    else:
        by_id: dict[str, FileMetadata] = {}
        for collection in collections - archived:
            for f in file_repo.get_files_by_collection(collection):
                if f.file_type == "tei":
                    by_id[f.stable_id] = f
        candidates = list(by_id.values())
    files = [f for f in candidates if not f.doc_collections or not all(c in archived for c in f.doc_collections)]
    files.sort(key=lambda f: f.updated_at, reverse=True)
    return files


def _history_entries(files: list[FileMetadata], file_storage: FileStorage) -> list[dict]:
    """All changes of the given TEI files, newest first."""
    entries: list[dict] = []
    for file_metadata in files:
        try:
            content_bytes = file_storage.read_file(file_metadata.id, "tei")
            if content_bytes:
                entries.extend(_extract_revision_info(content_bytes.decode("utf-8"), file_metadata))
        except Exception as e:
            logger.error(f"Failed to parse TEI file {file_metadata.id}: {e}")
    entries.sort(key=lambda x: x["timestamp"], reverse=True)
    return entries


@router.get("/all", response_class=HTMLResponse)
async def view_all_history(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    file_repo: FileRepository = Depends(get_file_repository),
    file_storage: FileStorage = Depends(get_file_storage),
) -> HTMLResponse:
    """HTML page with all changes in the non-archived projects the user can access, newest first."""
    from fastapi_app.config import get_settings
    from fastapi_app.lib.plugins.plugin_tools import escape_html, generate_datatable_page

    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")
    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    entries = _history_entries(_accessible_tei_files(user, file_repo, settings.db_dir), file_storage)
    rows = [
        [
            escape_html(entry["date_str"]),
            escape_html(entry["doc_id"]),
            f'<a href="#" onclick="sandbox.openDocument(\'{entry["stable_id"]}\'); return false;" style="color: #0066cc; text-decoration: underline;">{escape_html(entry["doc_label"])}</a>',
            escape_html(entry["description"]),
            escape_html(entry["who"]),
            escape_html(entry.get("status", "")),
        ]
        for entry in entries
    ]
    html = generate_datatable_page(
        title="Edit History - All Projects",
        headers=["Change Date", "Document ID", "Annotation Label", "Change Description", "Who", "Status"],
        rows=rows,
        table_id="editHistoryTable",
        page_length=25,
        default_sort_col=0,
        default_sort_dir="desc",
        enable_sandbox_client=True,
        custom_css="table { font-size: 0.9em; }",
    )
    return HTMLResponse(content=html)


@router.get("/recent")
async def recent_edits(
    limit: int = Query(10, ge=1, le=50, description="Number of changes"),
    user: dict[str, Any] = Depends(require_authenticated_user),
    file_repo: FileRepository = Depends(get_file_repository),
    file_storage: FileStorage = Depends(get_file_storage),
) -> dict[str, list[dict[str, Any]]]:
    """The latest changes in the non-archived projects the user can access (JSON, used by the dashboard box).

    Only the `limit * RECENT_FILES_FACTOR` most recently updated TEI files are read, since
    changes are added when a file is saved.
    """
    from fastapi_app.config import get_settings
    from fastapi_app.plugins.dashboard.documents import DocumentInfoResolver

    files = _accessible_tei_files(user, file_repo, get_settings().db_dir)[: limit * RECENT_FILES_FACTOR]
    resolver = DocumentInfoResolver(file_repo)
    entries: dict[str, dict[str, Any]] = {}
    edits: list[dict[str, Any]] = []
    for entry in _history_entries(files, file_storage)[:limit]:
        stable_id = entry["stable_id"]
        if stable_id not in entries:
            file_metadata = file_repo.get_file_by_stable_id(stable_id)
            if file_metadata is None:
                continue
            entries[stable_id] = resolver.entry(file_metadata)
        edits.append({
            **entries[stable_id],
            "description": entry["description"],
            "who": entry["who"],
            "change_status": entry["status"],
            "when": entry["timestamp"].isoformat(),
        })
    return {"edits": edits}


def _extract_revision_info(xml_content: str, file_metadata) -> list[dict]:
    """
    Extract revision information from TEI document.

    Args:
        xml_content: TEI XML content as string
        file_metadata: File metadata object

    Returns:
        List of revision entries (one per change element)
    """
    try:
        from fastapi_app.lib.utils.tei_utils import get_artifact_label, get_annotator_name

        root = etree.fromstring(xml_content.encode("utf-8"))
        ns = {
            "tei": "http://www.tei-c.org/ns/1.0",
        }

        doc_label = get_artifact_label(root) or "Untitled"

        # Get ALL change elements
        change_elements = root.findall(".//tei:revisionDesc/tei:change", ns)

        if not change_elements:
            return []

        # Get doc_id from file metadata
        doc_id = file_metadata.doc_id or "Unknown"

        # Extract all changes
        results = []
        for change in change_elements:
            # Extract change information
            when = change.get("when", "")
            who_attr = change.get("who", "")
            who_id = who_attr.lstrip("#")
            status = change.get("status", "")

            # Look up full name from respStmt using @xml:id
            who_name = get_annotator_name(root, who_attr)

            # Get description from text content or desc subelement
            desc_elem = change.find("tei:desc", ns)
            if desc_elem is not None and desc_elem.text:
                description = desc_elem.text.strip()
            elif change.text:
                description = change.text.strip()
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

            results.append({
                "timestamp": timestamp,
                "date_str": timestamp.strftime("%Y-%m-%d %H:%M:%S"),
                "doc_id": doc_id,
                "doc_label": doc_label,
                "description": description,
                "who_id": who_id,
                "who": who_name,
                "status": status,
                "stable_id": file_metadata.stable_id,
            })

        return results

    except Exception as e:
        logger.error(f"Error extracting revision info: {e}")
        return []
