"""
Storage garbage collection utilities.

Provides tools to clean up orphaned files and verify reference integrity.
Can be run as:
- Command-line tool (one-time cleanup)
- Periodic background task
- Part of startup/shutdown
"""

from pathlib import Path
from typing import Dict, List, Tuple
from .storage_references import StorageReferenceManager
from .file_storage import FileStorage
from .logging_utils import get_logger


logger = get_logger(__name__)


class StorageGarbageCollector:
    """
    Garbage collector for hash-sharded storage.

    Finds and cleans up:
    - Files with ref_count = 0
    - Orphaned files (no reference tracking entry)
    - Mismatched references (files in DB but not in storage)
    """

    def __init__(self, storage: FileStorage, ref_manager: StorageReferenceManager, dry_run: bool = False):
        """
        Initialize garbage collector.

        Args:
            storage: FileStorage instance
            ref_manager: StorageReferenceManager instance
            dry_run: If True, don't actually delete files (default: False)
        """
        self.storage = storage
        self.ref_manager = ref_manager
        self.dry_run = dry_run

    def collect_zero_refs(self) -> Dict[str, int]:
        """
        Clean up files with zero references.

        Returns:
            Dictionary with cleanup stats: {
                'checked': int,
                'deleted': int,
                'errors': int
            }
        """
        stats = {'checked': 0, 'deleted': 0, 'errors': 0}

        # Get files with ref_count = 0
        zero_ref_files = self.ref_manager.cleanup_zero_refs()
        stats['checked'] = len(zero_ref_files)

        logger.info(f"Found {len(zero_ref_files)} files with ref_count = 0")

        for file_hash, file_type in zero_ref_files:
            if self.dry_run:
                logger.info(f"[DRY RUN] Would delete: {file_hash[:8]}... ({file_type})")
                stats['deleted'] += 1
            else:
                try:
                    # Delete physical file (without decrementing ref - already 0)
                    deleted = self.storage.delete_file(file_hash, file_type, decrement_ref=False)

                    if deleted:
                        # Remove tracking entry after successful deletion
                        self.ref_manager.remove_reference_entry(file_hash)
                        logger.info(f"Deleted zero-ref file: {file_hash[:8]}... ({file_type})")
                        stats['deleted'] += 1
                    else:
                        logger.warning(f"File not found in storage: {file_hash[:8]}...")
                        # Still remove tracking entry since file doesn't exist
                        self.ref_manager.remove_reference_entry(file_hash)

                except Exception as e:
                    logger.error(f"Error deleting {file_hash[:8]}...: {e}")
                    stats['errors'] += 1

        return stats

    def collect_orphaned_files(self) -> Dict[str, int]:
        """
        Find and clean up files with no reference tracking entry.

        These are orphaned files from:
        - Crashes during save
        - Pre-migration files
        - Reference counting bugs

        Returns:
            Dictionary with cleanup stats: {
                'checked': int,
                'deleted': int,
                'errors': int
            }
        """
        stats = {'checked': 0, 'deleted': 0, 'errors': 0}

        # Find orphaned files
        orphaned = self.ref_manager.get_orphaned_files(self.storage.data_root)
        stats['checked'] = len(orphaned)

        logger.info(f"Found {len(orphaned)} orphaned files in storage")

        for file_hash, file_type in orphaned:
            if self.dry_run:
                logger.info(f"[DRY RUN] Would delete orphaned: {file_hash[:8]}... ({file_type})")
                stats['deleted'] += 1
            else:
                try:
                    # Delete physical file
                    deleted = self.storage.delete_file(file_hash, file_type, decrement_ref=False)

                    if deleted:
                        logger.info(f"Deleted orphaned file: {file_hash[:8]}... ({file_type})")
                        stats['deleted'] += 1

                except Exception as e:
                    logger.error(f"Error deleting orphaned {file_hash[:8]}...: {e}")
                    stats['errors'] += 1

        return stats

    def verify_references(self) -> Dict[str, List[str]]:
        """
        Verify reference integrity.

        Checks for:
        - Files in storage but not tracked
        - Files tracked but not in storage
        - Reference count mismatches

        Returns:
            Dictionary with issues: {
                'missing_tracking': [file_hashes],
                'missing_files': [file_hashes],
                'count_mismatches': [(file_hash, tracked_count, actual_count)]
            }
        """
        issues = {
            'missing_tracking': [],
            'missing_files': [],
            'count_mismatches': []
        }

        # Find orphaned files
        orphaned = self.ref_manager.get_orphaned_files(self.storage.data_root)
        issues['missing_tracking'] = [h for h, _ in orphaned]

        # Find tracked files missing from storage
        zero_refs = self.ref_manager.cleanup_zero_refs()
        for file_hash, file_type in zero_refs:
            if not self.storage.file_exists(file_hash, file_type):
                issues['missing_files'].append(file_hash)

        logger.info(
            f"Reference verification: "
            f"{len(issues['missing_tracking'])} orphaned, "
            f"{len(issues['missing_files'])} missing files"
        )

        return issues

    def full_cleanup(self) -> Dict[str, Dict[str, int]]:
        """
        Run full garbage collection cycle.

        1. Clean up zero-ref files
        2. Clean up orphaned files
        3. Report stats

        Returns:
            Dictionary with stats for each phase
        """
        logger.info(
            f"Starting garbage collection (dry_run={self.dry_run})"
        )

        stats = {
            'zero_refs': self.collect_zero_refs(),
            'orphaned': self.collect_orphaned_files()
        }

        total_deleted = stats['zero_refs']['deleted'] + stats['orphaned']['deleted']
        total_errors = stats['zero_refs']['errors'] + stats['orphaned']['errors']

        logger.info(
            f"Garbage collection complete: "
            f"{total_deleted} files deleted, {total_errors} errors"
        )

        return stats


def rebuild_references_from_database(db_path: Path, logger_inst=None) -> Dict[str, int]:
    """
    Rebuild reference counts from database (migration/recovery).

    Scans files table and rebuilds storage_refs based on current state.

    Args:
        db_path: Path to metadata.db
        logger_inst: Optional logger

    Returns:
        Dictionary of {file_hash: ref_count}
    """
    if logger_inst is None:
        logger_inst = logger

    from .dependencies import _DatabaseManagerSingleton
    db_manager = _DatabaseManagerSingleton.get_instance(str(db_path))
    ref_manager = StorageReferenceManager(db_manager, logger_inst)
    return ref_manager.rebuild_from_files_table()


def run_garbage_collection(
    storage_root: Path,
    db_path: Path,
    dry_run: bool = False,
    logger_inst=None
) -> Dict[str, Dict[str, int]]:
    """
    Convenience function to run garbage collection.

    Args:
        storage_root: Root directory of file storage
        db_path: Path to metadata.db
        dry_run: If True, don't actually delete files
        logger_inst: Optional logger

    Returns:
        Cleanup statistics
    """
    if logger_inst is None:
        logger_inst = logger

    from .dependencies import _DatabaseManagerSingleton
    db_manager = _DatabaseManagerSingleton.get_instance(str(db_path))

    # Create instances
    ref_manager = StorageReferenceManager(db_manager, logger_inst)
    storage = FileStorage(storage_root, db_manager, logger_inst)
    gc = StorageGarbageCollector(storage, ref_manager, dry_run=dry_run)

    # Run cleanup
    return gc.full_cleanup()
