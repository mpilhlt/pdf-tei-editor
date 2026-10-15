"""
Routes for the Metadata Extraction plugin.

Provides an endpoint to extract bibliographic metadata from a PDF
via DOI lookup or LLM-based extraction, and an admin endpoint to backfill
missing metadata for all documents of a collection.
"""

import asyncio
import logging
from functools import partial
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import HTMLResponse

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.sessions import SessionManager
from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_db,
    get_file_storage,
    get_session_manager,
    get_sse_service,
)
from fastapi_app.lib.permissions.acl_utils import user_is_admin
from fastapi_app.lib.sse.sse_service import SSEService
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.utils.auth import AuthManager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/metadata-extraction", tags=["metadata-extraction"])


@router.get("/extract")
async def extract_metadata(
    stable_id: str = Query(..., description="PDF stable ID"),
    doi: str | None = Query(None, description="DOI string (optional)"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """
    Extract bibliographic metadata for a PDF document.

    Tries DOI lookup first if doi is provided, otherwise falls back
    to LLM-based extraction via the extraction service.

    Returns:
        JSON with metadata fields (title, authors, date, publisher, etc.)
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.services.metadata_extraction import get_metadata_for_document

    # Authenticate
    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # Extract metadata
    metadata = await get_metadata_for_document(
        doi=doi,
        stable_id=stable_id,
    )

    return metadata


def _authorize_backfill(
    session_id: str | None,
    x_session_id: str | None,
    collection: str,
    session_manager: SessionManager,
    auth_manager: AuthManager,
) -> str:
    """
    Check that the request comes from an admin and the collection exists.

    Returns:
        The session ID

    Raises:
        HTTPException: 401 if not authenticated, 403 if not admin, 404 if the collection does not exist
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.utils.collection_utils import validate_collection

    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    if not user_is_admin(user):
        raise HTTPException(status_code=403, detail="Admin role required")

    if not validate_collection(collection, settings.db_dir):
        raise HTTPException(status_code=404, detail=f"Collection not found: {collection}")
    return session_id_value


@router.get("/backfill/options", response_class=HTMLResponse)
async def backfill_options(
    collection: str = Query(..., description="ID of the collection whose documents are backfilled"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager),
) -> HTMLResponse:
    """
    Options dialog for the collection backfill (admin only), opened from the plugin menu entry.
    """
    import html

    from fastapi_app.lib.plugins.plugin_tools import load_plugin_html

    _authorize_backfill(session_id, x_session_id, collection, session_manager, auth_manager)
    page = load_plugin_html(__file__, "backfill.html").replace("__COLLECTION__", html.escape(collection))
    return HTMLResponse(content=page)


@router.post("/backfill")
async def backfill_collection_metadata(
    collection: str = Query(..., description="ID of the collection whose documents are backfilled"),
    dry_run: bool = Query(False, description="Report what would be added without saving"),
    use_grobid: bool = Query(True, description="Use GROBID header extraction as fallback if available"),
    limit: int | None = Query(None, ge=1, description="Maximum number of documents to process"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager),
    sse_service: SSEService = Depends(get_sse_service),
    db: DatabaseManager = Depends(get_db),
    file_storage: FileStorage = Depends(get_file_storage),
) -> dict[str, Any]:
    """
    Backfill missing metadata for all documents of a collection (admin only).

    Adds data points that do not exist yet in the TEI headers (sourceDesc/biblStruct and
    profileDesc/langUsage) and the PDF's doc_metadata. Existing values are never overwritten.
    Metadata comes from CrossRef/DataCite if a DOI is known, otherwise from GROBID header
    extraction if the GROBID plugin is active and its server is ready. The document language
    is taken from the registry metadata or predicted from the PDF/TEI text.
    TEI files locked by another session are skipped.

    Returns:
        Report with keys collection, dry_run, summary, sources and documents
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.repository.file_repository import FileRepository
    from fastapi_app.lib.sse.sse_utils import ProgressBar, send_notification
    from fastapi_app.plugins.metadata_extraction.backfill import backfill_collection
    from fastapi_app.plugins.metadata_extraction.grobid_header import (
        fetch_grobid_header_metadata,
        get_live_grobid_server_url,
    )

    session_id_value = _authorize_backfill(session_id, x_session_id, collection, session_manager, auth_manager)
    settings = get_settings()

    grobid_fetcher = None
    grobid_server_url = await asyncio.to_thread(get_live_grobid_server_url) if use_grobid else None
    if grobid_server_url:
        grobid_fetcher = partial(fetch_grobid_header_metadata, server_url=grobid_server_url)

    progress = ProgressBar(sse_service, session_id_value)
    progress.show(label=f"Backfilling metadata in collection {collection}...")
    await asyncio.sleep(0)

    def on_progress(current: int, total: int, label: str) -> None:
        progress.set_label(label)
        if total > 0:
            progress.set_value(int(current / total * 100))

    try:
        report = await backfill_collection(
            collection_id=collection,
            file_repo=FileRepository(db),
            file_storage=file_storage,
            session_id=session_id_value,
            db_dir=settings.db_dir,
            grobid_fetcher=grobid_fetcher,
            dry_run=dry_run,
            limit=limit,
            progress_callback=on_progress,
        )
    finally:
        progress.hide()

    report["grobid_available"] = grobid_fetcher is not None
    summary = report["summary"]
    if not dry_run:
        send_notification(
            sse_service,
            session_id_value,
            f"Backfilled metadata for {summary['documents_updated']} of {summary['documents']} documents in {collection}",
            "success" if summary["errors"] == 0 else "warning",
        )
    return report
