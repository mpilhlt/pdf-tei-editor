"""
File garbage collection API router for FastAPI.

Implements POST /api/files/garbage_collect - Purge soft-deleted files.

This endpoint permanently deletes files that have been soft-deleted and meet
the specified criteria. It handles both database records and physical file storage.

Security:
- Requires authentication for all requests
- Requires admin role for timestamps younger than 24 hours (prevents accidental deletion)
"""

from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException

from ..lib.file_repository import FileRepository
from ..lib.file_storage import FileStorage
from ..lib.models_files import GarbageCollectRequest, GarbageCollectResponse
from ..lib.dependencies import (
    get_file_repository,
    get_file_storage,
    require_authenticated_user
)
from ..lib.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


@router.post("/garbage_collect", response_model=GarbageCollectResponse)
def garbage_collect_files(
    body: GarbageCollectRequest,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    current_user: dict = Depends(require_authenticated_user)
) -> GarbageCollectResponse:
    """
    Garbage collect soft-deleted files older than the specified timestamp.

    Permanently removes files that have been soft-deleted and meet all filter criteria:
    - deleted=1 (soft-deleted)
    - updated_at < deleted_before timestamp
    - sync_status matches (if provided)

    Filters are additive - all conditions must match if they have a value.

    Security:
    - Admin role required for timestamps younger than 24 hours (prevents accidental deletion)
    - All users can garbage collect files older than 24 hours

    This operation:
    1. Finds all deleted files matching the criteria
    2. Removes physical files from storage
    3. Permanently deletes database records
    4. Returns statistics about purged files

    Args:
        body: GarbageCollectRequest with timestamp and optional filters
        repo: File repository (injected)
        storage: File storage (injected)
        current_user: Current user dict (injected)

    Returns:
        GarbageCollectResponse with purge statistics

    Raises:
        HTTPException: 403 if non-admin user tries to purge files deleted within 24 hours
    """
    # Check if timestamp is within 24 hours (requires admin)
    now = datetime.now(timezone.utc)
    # Ensure deleted_before is timezone-aware for comparison
    deleted_before = body.deleted_before
    if deleted_before.tzinfo is None:
        deleted_before = deleted_before.replace(tzinfo=timezone.utc)

    time_difference = now - deleted_before
    is_recent = time_difference < timedelta(hours=24)

    user_roles = current_user.get('roles', [])
    is_admin = '*' in user_roles or 'admin' in user_roles

    if is_recent and not is_admin:
        logger.warning(
            f"Non-admin user {current_user['username']} attempted to garbage collect "
            f"recently deleted files (deleted_before={body.deleted_before})"
        )
        raise HTTPException(
            status_code=403,
            detail="Admin role required to garbage collect files deleted within the last 24 hours"
        )

    logger.info(
        f"Starting garbage collection for files deleted before {body.deleted_before}, "
        f"user={current_user['username']} (admin={is_admin}), sync_status={body.sync_status}"
    )

    # Get deleted files eligible for garbage collection
    deleted_files = repo.get_deleted_files_for_gc(
        deleted_before=body.deleted_before,
        sync_status=body.sync_status
    )

    if not deleted_files:
        logger.info("No files to garbage collect")
        return GarbageCollectResponse(
            purged_count=0,
            files_deleted=0,
            storage_freed=0
        )

    logger.info(f"Found {len(deleted_files)} files eligible for garbage collection")

    # Track statistics
    purged_count = 0
    files_deleted = 0
    storage_freed = 0

    # Track which physical files we've already deleted (deduplication)
    deleted_hashes = set()

    # Process each file
    for file_metadata in deleted_files:
        file_hash = file_metadata.id
        file_type = file_metadata.file_type

        try:
            # Permanently delete the database record
            repo.permanently_delete_file(file_hash)
            purged_count += 1

            # Check if we should delete the physical file
            # Only delete if:
            # 1. We haven't already deleted it in this batch
            # 2. There are no more database references to it
            if file_hash not in deleted_hashes:
                ref_count = repo.ref_manager.get_reference_count(file_hash)

                if ref_count == 0:
                    # Get file size before deletion for statistics
                    file_path = storage.get_file_path(file_hash, file_type)
                    file_size = file_path.stat().st_size if file_path and file_path.exists() else 0

                    if file_path and file_path.exists():
                        # Physically delete the file (force delete, bypass ref counting)
                        deleted = storage.delete_file(file_hash, file_type, decrement_ref=False)

                        if deleted:
                            files_deleted += 1
                            storage_freed += file_size
                            deleted_hashes.add(file_hash)
                            # Clean up reference entry
                            repo.ref_manager.remove_reference_entry(file_hash)
                            logger.debug(
                                f"Deleted physical file {file_hash[:8]}... "
                                f"({file_size} bytes)"
                            )
                else:
                    logger.debug(
                        f"Not deleting physical file {file_hash[:8]}... - "
                        f"still has {ref_count} reference(s)"
                    )

        except ValueError as e:
            logger.warning(f"Failed to purge file {file_hash[:8]}...: {e}")
            continue
        except Exception as e:
            logger.error(f"Unexpected error purging file {file_hash[:8]}...: {e}")
            continue

    logger.info(
        f"Garbage collection completed: {purged_count} records purged, "
        f"{files_deleted} physical files deleted, {storage_freed} bytes freed"
    )

    # Clean up orphaned files (files in storage with no database entry)
    logger.info("Scanning for orphaned files...")
    orphaned_files = storage.find_orphaned_files(repo)

    orphaned_count = 0
    orphaned_size = 0

    for file_hash, file_type, file_path, file_size in orphaned_files:
        try:
            # Delete the orphaned file
            file_path.unlink()
            orphaned_count += 1
            orphaned_size += file_size
            files_deleted += 1
            storage_freed += file_size

            # Clean up reference entry if it exists
            repo.ref_manager.remove_reference_entry(file_hash)

            logger.info(
                f"Deleted orphaned file: {file_hash[:8]}... ({file_type}, {file_size} bytes)"
            )

            # Clean up empty shard directory
            shard_dir = file_path.parent
            try:
                if shard_dir.exists() and not any(shard_dir.iterdir()):
                    shard_dir.rmdir()
                    logger.debug(f"Removed empty shard directory: {shard_dir.name}")
            except (OSError, FileNotFoundError):
                pass

        except Exception as e:
            logger.error(f"Failed to delete orphaned file {file_hash[:8]}...: {e}")
            continue

    if orphaned_count > 0:
        logger.info(
            f"Orphan cleanup completed: {orphaned_count} orphaned files deleted, "
            f"{orphaned_size} bytes freed"
        )
    else:
        logger.info("No orphaned files found")

    return GarbageCollectResponse(
        purged_count=purged_count,
        files_deleted=files_deleted,
        storage_freed=storage_freed
    )
