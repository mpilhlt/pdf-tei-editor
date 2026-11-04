"""
File garbage collection API router for FastAPI.

Implements POST /api/files/garbage_collect: runs the garbage-collection tasks of the GC registry
(``lib/core/gc_registry.py``): purge of soft-deleted files, orphan scans, message index cleanup,
caches, plugin data and temporary files. Each task reports its own statistics.

Security:
- Requires authentication for all requests
- Requires admin role for timestamps younger than 24 hours (prevents accidental deletion)
"""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException

from ..config import get_settings
from ..lib.core.dependencies import get_file_repository, get_file_storage, require_authenticated_user
from ..lib.core.gc_hooks import PLUGIN_TASK_PREFIX
from ..lib.core.gc_registry import GcContext, GcTaskRun, run_gc
from ..lib.models.models_files import (
    GarbageCollectRequest,
    GarbageCollectResponse,
    GarbageCollectTaskResult,
    GarbageCollectTotals,
)
from ..lib.repository.file_repository import FileRepository
from ..lib.storage.file_storage import FileStorage
from ..lib.utils.logging_utils import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


def build_response(runs: list[GcTaskRun], dry_run: bool) -> GarbageCollectResponse:
    """The response of a GC run, with the deprecated top-level fields derived from the task results."""
    tasks = [
        GarbageCollectTaskResult(
            id=run.id,
            label=run.label,
            items_deleted=run.result.items_deleted,
            bytes_freed=run.result.bytes_freed,
            details=run.result.details,
            errors=run.result.errors,
            skipped=run.result.skipped,
        )
        for run in runs
    ]
    by_id = {t.id: t for t in tasks}
    return GarbageCollectResponse(
        tasks=tasks,
        totals=GarbageCollectTotals(
            items_deleted=sum(t.items_deleted for t in tasks),
            bytes_freed=sum(t.bytes_freed for t in tasks),
        ),
        dry_run=dry_run,
        purged_count=sum(t.details.get("records_purged", 0) for t in tasks),
        files_deleted=sum(t.details.get("files_deleted", 0) for t in tasks),
        storage_freed=sum(t.bytes_freed for t in tasks if "files_deleted" in t.details),  # file storage only
        orphaned_xml_deleted=by_id["orphaned-xml"].items_deleted if "orphaned-xml" in by_id else 0,
        plugin_items_deleted={
            t.id[len(PLUGIN_TASK_PREFIX):]: t.items_deleted for t in tasks if t.id.startswith(PLUGIN_TASK_PREFIX)
        },
        annotation_rules_cache_deleted=(
            by_id["annotation-rules-cache"].items_deleted if "annotation-rules-cache" in by_id else 0
        ),
    )


@router.post("/garbage_collect", response_model=GarbageCollectResponse)
def garbage_collect_files(
    body: GarbageCollectRequest,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    current_user: dict = Depends(require_authenticated_user),
) -> GarbageCollectResponse:
    """
    Run all garbage-collection tasks.

    Soft-deleted files are purged if they were last updated before ``deleted_before`` and match
    ``sync_status`` (if given). The other tasks (orphan scans, message index, caches, plugin data,
    tmp dir) do not depend on the filters. With ``dry_run``, the tasks only report what they would
    delete; tasks that cannot do a dry run are skipped. ``tasks`` restricts the run to these task ids.

    Security:
    - Admin role required for timestamps younger than 24 hours (prevents accidental deletion)
    - All users can garbage collect files older than 24 hours

    Args:
        body: GarbageCollectRequest with timestamp and optional filters
        repo: File repository (injected)
        storage: File storage (injected)
        current_user: Current user dict (injected)

    Returns:
        GarbageCollectResponse with one result per task and the totals

    Raises:
        HTTPException: 403 if non-admin user tries to purge files deleted within 24 hours
    """
    deleted_before = body.deleted_before
    if deleted_before.tzinfo is None:
        deleted_before = deleted_before.replace(tzinfo=timezone.utc)
    is_recent = datetime.now(timezone.utc) - deleted_before < timedelta(hours=24)

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
        f"Starting garbage collection{' (dry run)' if body.dry_run else ''} for files deleted before "
        f"{body.deleted_before}, user={current_user['username']} (admin={is_admin}), sync_status={body.sync_status}"
    )
    context = GcContext(
        deleted_before=body.deleted_before,
        file_repo=repo,
        file_storage=storage,
        db_dir=get_settings().db_dir,
        sync_status=body.sync_status,
        is_admin=is_admin,
        dry_run=body.dry_run,
    )
    response = build_response(run_gc(context, body.tasks), body.dry_run)
    logger.info(
        f"Garbage collection completed: {len(response.tasks)} tasks, {response.totals.items_deleted} items, "
        f"{response.totals.bytes_freed} bytes"
    )
    return response
