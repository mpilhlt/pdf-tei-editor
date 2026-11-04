#!/usr/bin/env python3
"""
Delete orphaned XML files (TEI files whose document has no non-deleted PDF).

Runs the ``orphaned-xml`` task of the garbage-collection registry
(``fastapi_app/lib/storage/file_gc.py``), which purges the records and the physical files.
On a running server, prefer ``npm run manage-remote -- maintenance gc --task orphaned-xml``.

Usage:
    uv run python bin/cleanup-orphaned-xml.py [--dry-run]

Options:
    --dry-run    Show what would be deleted without deleting anything
"""

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi_app.config import get_settings  # noqa: E402
from fastapi_app.lib.core.dependencies import get_db, get_file_storage  # noqa: E402
from fastapi_app.lib.core.gc_registry import GcContext, run_gc  # noqa: E402
from fastapi_app.lib.repository.file_repository import FileRepository  # noqa: E402
from fastapi_app.lib.storage.file_gc import register_file_gc_tasks  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Delete orphaned XML files (XML with no corresponding PDF)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be deleted without deleting anything")
    args = parser.parse_args()

    register_file_gc_tasks()
    context = GcContext(
        deleted_before=datetime.now(timezone.utc),
        file_repo=FileRepository(get_db()),
        file_storage=get_file_storage(),
        db_dir=get_settings().db_dir,
        is_admin=True,
        dry_run=args.dry_run,
    )
    print(f"Database: {get_settings().db_dir / 'metadata.db'}")
    print(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE (will delete)'}")
    for run in run_gc(context, ["orphaned-xml"]):
        result = run.result
        verb = "Would delete" if args.dry_run else "Deleted"
        print(f"{verb} {result.items_deleted} orphaned XML records, {result.details.get('files_deleted', 0)} "
              f"physical files ({result.bytes_freed} bytes)")
        for error in result.errors:
            print(f"  ERROR: {error}")
        if result.errors:
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
