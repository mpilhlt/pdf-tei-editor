"""
WebDAV sync plugin custom routes.

Provides HTTP endpoints for sync status, execution, conflict listing,
and conflict resolution at /api/plugins/webdav-sync/*.
"""

import logging
from fastapi import APIRouter, HTTPException, Depends, Header, Query

from fastapi_app.lib.core.dependencies import (
    get_db,
    get_file_storage,
    get_sse_service,
    get_session_manager,
    get_auth_manager,
)
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.sync.models import (
    SyncStatusResponse,
    SyncRequest,
    SyncSummary,
    ConflictListResponse,
    ConflictResolution,
)

from .config import get_webdav_config, is_configured
from .service import SyncService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/webdav-sync", tags=["webdav-sync"])


def _get_authenticated_user(
    session_id: str | None,
    x_session_id: str | None,
    session_manager,
    auth_manager,
) -> dict:
    """Authenticate and return user dict, raising HTTPException on failure."""
    from fastapi_app.config import get_settings
    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def _get_sync_service(user: dict, db, file_storage, sse_service) -> SyncService:
    """Build a SyncService instance using plugin config."""
    file_repo = FileRepository(db)
    webdav_config = get_webdav_config()
    return SyncService(
        file_repo=file_repo,
        file_storage=file_storage,
        webdav_config=webdav_config,
        sse_service=sse_service,
        logger=logger,
    )


@router.get("/status", response_model=SyncStatusResponse)
def get_sync_status(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    db=Depends(get_db),
    file_storage=Depends(get_file_storage),
    sse_service=Depends(get_sse_service),
) -> SyncStatusResponse:
    """Check if synchronization is needed (O(1) operation)."""
    user = _get_authenticated_user(session_id, x_session_id, session_manager, auth_manager)

    if not is_configured():
        return SyncStatusResponse(
            needs_sync=False,
            local_version=0,
            remote_version=0,
            unsynced_count=0,
            sync_in_progress=False,
        )

    try:
        sync_service = _get_sync_service(user, db, file_storage, sse_service)
        return sync_service.check_status()
    except Exception as e:
        logger.error(f"Failed to check sync status: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to check sync status: {str(e)}")


@router.post("/sync", response_model=SyncSummary)
def perform_sync(
    request: SyncRequest,
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    db=Depends(get_db),
    file_storage=Depends(get_file_storage),
    sse_service=Depends(get_sse_service),
) -> SyncSummary:
    """Perform WebDAV synchronization with SSE progress updates."""
    user = _get_authenticated_user(session_id, x_session_id, session_manager, auth_manager)

    if not is_configured():
        return SyncSummary(skipped=True, message="WebDAV not configured")

    try:
        sync_service = _get_sync_service(user, db, file_storage, sse_service)
        file_repo = FileRepository(db)
        client_id = user.get('username')

        file_repo.set_sync_metadata('sync_in_progress', '1')
        try:
            summary = sync_service.perform_sync(client_id=client_id, force=request.force)
            file_repo.set_sync_metadata('last_sync_summary', summary.model_dump_json())
        finally:
            file_repo.set_sync_metadata('sync_in_progress', '0')

        return summary
    except Exception as e:
        logger.error(f"Sync failed: {e}")
        raise HTTPException(status_code=500, detail=f"Sync failed: {str(e)}")


@router.get("/conflicts", response_model=ConflictListResponse)
def list_conflicts(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    db=Depends(get_db),
    file_storage=Depends(get_file_storage),
    sse_service=Depends(get_sse_service),
) -> ConflictListResponse:
    """List files with sync conflicts."""
    user = _get_authenticated_user(session_id, x_session_id, session_manager, auth_manager)

    if not is_configured():
        return ConflictListResponse(conflicts=[], total=0)

    try:
        sync_service = _get_sync_service(user, db, file_storage, sse_service)
        return sync_service.get_conflicts()
    except Exception as e:
        logger.error(f"Failed to list conflicts: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to list conflicts: {str(e)}")


@router.post("/resolve")
def resolve_conflict(
    resolution: ConflictResolution,
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    db=Depends(get_db),
    file_storage=Depends(get_file_storage),
    sse_service=Depends(get_sse_service),
) -> dict:
    """Resolve a sync conflict."""
    user = _get_authenticated_user(session_id, x_session_id, session_manager, auth_manager)

    if not is_configured():
        raise HTTPException(status_code=400, detail="WebDAV not configured")

    try:
        sync_service = _get_sync_service(user, db, file_storage, sse_service)
        return sync_service.resolve_conflict(resolution)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to resolve conflict: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to resolve conflict: {str(e)}")
