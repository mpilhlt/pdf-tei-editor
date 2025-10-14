"""
Synchronization router for FastAPI.

Provides endpoints for:
- Sync status checking (O(1))
- Performing synchronization with progress updates
- Listing and resolving conflicts

For FastAPI migration - Phase 6.
"""

from fastapi import APIRouter, HTTPException, Depends
import logging

from ..lib.models_sync import (
    SyncStatusResponse,
    SyncRequest,
    SyncSummary,
    ConflictListResponse,
    ConflictResolution
)
from ..lib.dependencies import (
    get_sync_service,
    get_session_user
)
from ..lib.sync_service import SyncService

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/sync", tags=["sync"])


@router.get("/status", response_model=SyncStatusResponse)
def get_sync_status(
    sync_service: SyncService = Depends(get_sync_service),
    user: dict = Depends(get_session_user)
) -> SyncStatusResponse:
    """
    Check if synchronization is needed (O(1) operation).

    Performs quick checks:
    - Count of unsynced files in local database
    - Local vs remote version comparison

    Returns:
        Sync status with version info and unsynced count
    """
    try:
        status = sync_service.check_if_sync_needed()

        # Get last sync time
        last_sync_str = sync_service.file_repo.get_sync_metadata('last_sync_time')
        from datetime import datetime
        last_sync_time = datetime.fromisoformat(last_sync_str) if last_sync_str else None

        # Check if sync in progress
        sync_in_progress_str = sync_service.file_repo.get_sync_metadata('sync_in_progress')
        sync_in_progress = sync_in_progress_str == '1' if sync_in_progress_str else False

        return SyncStatusResponse(
            needs_sync=status['needs_sync'],
            local_version=status['local_version'],
            remote_version=status['remote_version'],
            unsynced_count=status['unsynced_count'],
            last_sync_time=last_sync_time,
            sync_in_progress=sync_in_progress
        )

    except Exception as e:
        logger.error(f"Failed to check sync status: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to check sync status: {str(e)}")


@router.post("", response_model=SyncSummary)
def perform_sync(
    request: SyncRequest,
    sync_service: SyncService = Depends(get_sync_service),
    user: dict = Depends(get_session_user)
) -> SyncSummary:
    """
    Perform database-driven synchronization.

    Process:
    1. Quick skip check (unless force=true)
    2. Acquire remote lock
    3. Download remote metadata.db
    4. Compare metadata (find changes)
    5. Sync deletions (via database flags)
    6. Sync data files (upload/download)
    7. Sync metadata changes (no file transfers)
    8. Upload updated metadata.db
    9. Release lock

    Progress updates are sent via SSE to the user's session.

    Args:
        request: Sync request with force flag

    Returns:
        Summary of sync operations performed
    """
    try:
        # Mark sync as in progress
        sync_service.file_repo.set_sync_metadata('sync_in_progress', '1')

        try:
            # Perform sync with SSE progress updates
            # Use username as client_id for SSE
            client_id = user.get('username')

            summary = sync_service.perform_sync(
                client_id=client_id,
                force=request.force
            )

            # Store summary
            import json
            summary_json = summary.model_dump_json()
            sync_service.file_repo.set_sync_metadata('last_sync_summary', summary_json)

            return summary

        finally:
            # Clear sync in progress flag
            sync_service.file_repo.set_sync_metadata('sync_in_progress', '0')

    except Exception as e:
        logger.error(f"Sync failed: {e}")
        raise HTTPException(status_code=500, detail=f"Sync failed: {str(e)}")


@router.get("/conflicts", response_model=ConflictListResponse)
def list_conflicts(
    sync_service: SyncService = Depends(get_sync_service),
    user: dict = Depends(get_session_user)
) -> ConflictListResponse:
    """
    List files with sync conflicts.

    Conflicts occur when:
    - File modified locally and remotely
    - File deleted remotely but modified locally
    - File deleted locally but modified remotely

    Returns:
        List of conflicts with details
    """
    try:
        # Get files with conflict status
        from ..lib.models import FileMetadata

        conflicts = []
        conflict_files = [
            f for f in sync_service.file_repo.get_all_files()
            if f.sync_status == 'conflict'
        ]

        from ..lib.models_sync import ConflictInfo
        for file in conflict_files:
            conflict = ConflictInfo(
                file_id=file.id,
                stable_id=file.stable_id,
                filename=file.filename,
                doc_id=file.doc_id,
                local_modified_at=file.local_modified_at,
                local_hash=file.id,
                remote_modified_at=None,  # Would need to query remote
                remote_hash=file.sync_hash,
                conflict_type='modified_both'  # Simplified
            )
            conflicts.append(conflict)

        return ConflictListResponse(
            conflicts=conflicts,
            total=len(conflicts)
        )

    except Exception as e:
        logger.error(f"Failed to list conflicts: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to list conflicts: {str(e)}")


@router.post("/resolve-conflict")
def resolve_conflict(
    resolution: ConflictResolution,
    sync_service: SyncService = Depends(get_sync_service),
    user: dict = Depends(get_session_user)
) -> dict:
    """
    Resolve a sync conflict.

    Strategies:
    - local_wins: Keep local version, mark as modified for upload
    - remote_wins: Download remote version, overwrite local
    - keep_both: Create new variant with local version

    Args:
        resolution: Conflict resolution request

    Returns:
        Success message
    """
    try:
        file_id = resolution.file_id

        if resolution.resolution == 'local_wins':
            # Mark file as modified to trigger upload
            from ..lib.models import SyncUpdate
            sync_service.file_repo.update_sync_status(
                file_id,
                SyncUpdate(sync_status='modified', sync_hash=None)
            )
            message = "Local version will be uploaded on next sync"

        elif resolution.resolution == 'remote_wins':
            # Mark file as synced to accept remote version
            # Next sync will download remote version
            remote_version_str = sync_service.file_repo.get_sync_metadata('remote_version')
            remote_version = int(remote_version_str) if remote_version_str else 0

            sync_service.file_repo.mark_file_synced(file_id, remote_version)
            message = "Remote version will be downloaded on next sync"

        elif resolution.resolution == 'keep_both':
            # Create new variant (requires variant name)
            if not resolution.new_variant:
                raise HTTPException(
                    status_code=400,
                    detail="new_variant required for keep_both resolution"
                )

            # TODO: Implement variant creation
            # This would involve:
            # 1. Duplicate file with new variant
            # 2. Mark original as synced
            message = f"Created variant '{resolution.new_variant}' (not implemented)"

        else:
            raise HTTPException(status_code=400, detail="Invalid resolution strategy")

        return {"message": message}

    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to resolve conflict: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to resolve conflict: {str(e)}")
