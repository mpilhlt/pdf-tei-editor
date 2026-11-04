"""
Garbage-collection tasks of the file repository and storage (see ``lib/core/gc_registry.py``).

Tasks, in run order:

- ``deleted-files``: purge soft-deleted files older than ``deleted_before`` (records and physical files)
- ``orphaned-storage-files``: delete storage files without a database record, remove empty shard dirs
- ``duplicate-entries``: remove duplicate database records (no dry run)
- ``tei-collections``: sync the collections of TEI files with their PDF (no dry run)
- ``inbox-assignment``: assign ``_inbox`` to files without a collection (no dry run)
- ``orphaned-xml``: purge TEI files whose document has no PDF

In a dry run, ``bytes_freed`` of the purge tasks counts all existing physical files of the
purged records, also those that other records still reference.
"""

from __future__ import annotations

from fastapi_app.lib.core.gc_registry import GcContext, GcResult, register_gc_task
from fastapi_app.lib.models.models import FileMetadata
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.utils.logging_utils import get_logger

logger = get_logger(__name__)


def _file_size(storage: FileStorage, file: FileMetadata) -> int:
    path = storage.get_file_path(file.id, file.file_type)
    try:
        return path.stat().st_size if path and path.exists() else 0
    except OSError:
        return 0


def _purge_records(repo: FileRepository, storage: FileStorage, files: list[FileMetadata], dry_run: bool,
                   what: str, release_refs: bool = False) -> GcResult:
    """
    Permanently delete file records and the physical files no other record references.

    Args:
        repo: File repository
        storage: File storage
        files: The records to purge
        dry_run: Only count
        what: Description for log messages
        release_refs: Decrement the storage reference of each record first (records that were not
            soft-deleted, whose reference the soft delete did not release)

    Returns:
        ``items_deleted`` = records purged; details ``records_purged`` and ``files_deleted``
    """
    result = GcResult()
    records = 0
    files_deleted = 0
    deleted_hashes: set[str] = set()
    for file in files:
        file_hash = file.id
        size = _file_size(storage, file)
        if dry_run:
            records += 1
            if size and file_hash not in deleted_hashes:
                files_deleted += 1
                result.bytes_freed += size
                deleted_hashes.add(file_hash)
            continue
        try:
            repo.permanently_delete_file(file_hash)
            records += 1
            if release_refs:
                repo.ref_manager.decrement_reference(file_hash)
            if file_hash in deleted_hashes:
                continue
            ref_count = repo.ref_manager.get_reference_count(file_hash)
            if ref_count != 0:
                logger.debug(f"Not deleting physical file {file_hash[:8]}... - still has {ref_count} reference(s)")
                continue
            path = storage.get_file_path(file_hash, file.file_type)
            if path and path.exists() and storage.delete_file(file_hash, file.file_type, decrement_ref=False):
                files_deleted += 1
                result.bytes_freed += size
                deleted_hashes.add(file_hash)
                repo.ref_manager.remove_reference_entry(file_hash)
                logger.debug(f"Deleted physical file {file_hash[:8]}... ({size} bytes)")
        except Exception as e:
            logger.warning(f"Failed to purge {what} {file_hash[:8]}...: {e}")
            result.errors.append(f"{file_hash[:8]}: {e}")
    result.items_deleted = records
    result.details = {"records_purged": records, "files_deleted": files_deleted}
    return result


def purge_deleted_files(ctx: GcContext) -> GcResult:
    """Purge soft-deleted files last updated before ``deleted_before`` (and matching ``sync_status``)."""
    files = ctx.file_repo.get_deleted_files_for_gc(deleted_before=ctx.deleted_before, sync_status=ctx.sync_status)
    return _purge_records(ctx.file_repo, ctx.file_storage, files, ctx.dry_run, "file")


def delete_orphaned_storage_files(ctx: GcContext) -> GcResult:
    """Delete files in storage that have no database record, and the shard directories they leave empty."""
    result = GcResult()
    shard_dirs = 0
    for file_hash, file_type, file_path, file_size in ctx.file_storage.find_orphaned_files(ctx.file_repo):
        if ctx.dry_run:
            result.items_deleted += 1
            result.bytes_freed += file_size
            continue
        try:
            file_path.unlink()
            result.items_deleted += 1
            result.bytes_freed += file_size
            ctx.file_repo.ref_manager.remove_reference_entry(file_hash)
            logger.info(f"Deleted orphaned file: {file_hash[:8]}... ({file_type}, {file_size} bytes)")
        except Exception as e:
            logger.error(f"Failed to delete orphaned file {file_hash[:8]}...: {e}")
            result.errors.append(f"{file_hash[:8]}: {e}")
            continue
        shard_dir = file_path.parent
        try:
            if shard_dir.exists() and not any(shard_dir.iterdir()):
                shard_dir.rmdir()
                shard_dirs += 1
        except OSError:
            pass
    result.details = {"files_deleted": result.items_deleted, "shard_dirs_removed": shard_dirs}
    return result


def remove_duplicate_entries(ctx: GcContext) -> GcResult:
    """Remove duplicate database records (same content, doc_id and file type)."""
    count = ctx.file_repo.remove_duplicate_entries()
    return GcResult(items_deleted=count, details={"records_purged": count})


def sync_tei_collections(ctx: GcContext) -> GcResult:
    """Give TEI files the collections of their PDF."""
    return GcResult(details={"rows_updated": ctx.file_repo.sync_tei_collections_with_pdf()})


def assign_inbox(ctx: GcContext) -> GcResult:
    """Assign the ``_inbox`` collection to files without a collection."""
    return GcResult(details={"rows_updated": ctx.file_repo.assign_inbox_to_collectionless_files()})


def purge_orphaned_xml(ctx: GcContext) -> GcResult:
    """Purge TEI files whose document has no (non-deleted) PDF."""
    files = ctx.file_repo.get_orphaned_xml_files()
    for file in files:
        logger.info(f"{'Would delete' if ctx.dry_run else 'Deleting'} orphaned XML file: {file.id[:8]}... "
                    f"(doc_id={file.doc_id}, variant={file.variant})")
    return _purge_records(ctx.file_repo, ctx.file_storage, files, ctx.dry_run, "orphaned XML file", release_refs=True)


def register_file_gc_tasks() -> None:
    """Register the tasks of the file repository and storage."""
    register_gc_task("deleted-files", "Deleted files", purge_deleted_files, order=100)
    register_gc_task("orphaned-storage-files", "Orphaned storage files", delete_orphaned_storage_files, order=200)
    register_gc_task("duplicate-entries", "Duplicate file records", remove_duplicate_entries, order=300,
                     supports_dry_run=False)
    register_gc_task("tei-collections", "TEI collections synced with PDF", sync_tei_collections, order=400,
                     supports_dry_run=False)
    register_gc_task("inbox-assignment", "Files moved to the inbox", assign_inbox, order=410, supports_dry_run=False)
    register_gc_task("orphaned-xml", "Orphaned XML files", purge_orphaned_xml, order=500)
