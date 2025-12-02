#!/usr/bin/env python3
"""
Storage Garbage Collection CLI Tool

Usage:
    python fastapi_app/cli_storage_gc.py [--dry-run] [--rebuild-refs]

Options:
    --dry-run        Show what would be deleted without actually deleting
    --rebuild-refs   Rebuild reference counts from database (migration/recovery)
    --verify         Verify reference integrity without cleanup

Examples:
    # Dry run (see what would be deleted)
    python fastapi_app/cli_storage_gc.py --dry-run

    # Actual cleanup
    python fastapi_app/cli_storage_gc.py

    # Rebuild references from database (after migration)
    python fastapi_app/cli_storage_gc.py --rebuild-refs

    # Verify integrity only
    python fastapi_app/cli_storage_gc.py --verify
"""

import sys
import argparse
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi_app.config import get_settings
from fastapi_app.lib.storage_gc import (
    run_garbage_collection,
    rebuild_references_from_database,
    StorageGarbageCollector
)
from fastapi_app.lib.file_storage import FileStorage
from fastapi_app.lib.storage_references import StorageReferenceManager
from fastapi_app.lib.logging_utils import get_logger


def main():
    parser = argparse.ArgumentParser(
        description='Storage garbage collection for hash-sharded files',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Show what would be deleted without actually deleting'
    )
    parser.add_argument(
        '--rebuild-refs',
        action='store_true',
        help='Rebuild reference counts from database'
    )
    parser.add_argument(
        '--verify',
        action='store_true',
        help='Verify reference integrity without cleanup'
    )

    args = parser.parse_args()

    # Setup
    settings = get_settings()
    logger = get_logger(__name__)
    storage_root = settings.data_root / "files"
    db_path = settings.db_dir / "metadata.db"

    print(f"Storage root: {storage_root}")
    print(f"Database: {db_path}")
    print(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE'}")
    print()

    # Rebuild references if requested
    if args.rebuild_refs:
        print("=" * 60)
        print("REBUILDING REFERENCE COUNTS FROM DATABASE")
        print("=" * 60)

        ref_counts = rebuild_references_from_database(db_path, logger)

        print(f"\n✓ Rebuilt references for {len(ref_counts)} files")
        print("\nSample references:")
        for i, (file_hash, count) in enumerate(list(ref_counts.items())[:5]):
            print(f"  {file_hash[:8]}... -> {count} reference(s)")
        print()

    # Verify if requested
    if args.verify:
        print("=" * 60)
        print("VERIFYING REFERENCE INTEGRITY")
        print("=" * 60)

        ref_manager = StorageReferenceManager(db_path, logger)
        storage = FileStorage(storage_root, db_path, logger)
        gc = StorageGarbageCollector(storage, ref_manager, dry_run=True)

        issues = gc.verify_references()

        print(f"\nOrphaned files (in storage, not tracked): {len(issues['missing_tracking'])}")
        if issues['missing_tracking']:
            print("Sample orphaned files:")
            for file_hash in issues['missing_tracking'][:5]:
                print(f"  {file_hash[:8]}...")

        print(f"\nMissing files (tracked, not in storage): {len(issues['missing_files'])}")
        if issues['missing_files']:
            print("Sample missing files:")
            for file_hash in issues['missing_files'][:5]:
                print(f"  {file_hash[:8]}...")

        print()

        if not issues['missing_tracking'] and not issues['missing_files']:
            print("✓ All references are valid!")

        return

    # Run garbage collection
    print("=" * 60)
    print("RUNNING GARBAGE COLLECTION")
    print("=" * 60)

    stats = run_garbage_collection(storage_root, db_path, dry_run=args.dry_run, logger_inst=logger)

    # Print results
    print("\n" + "=" * 60)
    print("RESULTS")
    print("=" * 60)

    print("\nZero-reference files:")
    print(f"  Checked: {stats['zero_refs']['checked']}")
    print(f"  Deleted: {stats['zero_refs']['deleted']}")
    print(f"  Errors:  {stats['zero_refs']['errors']}")

    print("\nOrphaned files:")
    print(f"  Checked: {stats['orphaned']['checked']}")
    print(f"  Deleted: {stats['orphaned']['deleted']}")
    print(f"  Errors:  {stats['orphaned']['errors']}")

    total_deleted = stats['zero_refs']['deleted'] + stats['orphaned']['deleted']
    total_errors = stats['zero_refs']['errors'] + stats['orphaned']['errors']

    print(f"\nTotal deleted: {total_deleted}")
    print(f"Total errors:  {total_errors}")

    if args.dry_run:
        print("\n⚠️  DRY RUN - No files were actually deleted")
        print("Run without --dry-run to perform actual cleanup")
    else:
        print("\n✓ Cleanup complete")


if __name__ == '__main__':
    main()
