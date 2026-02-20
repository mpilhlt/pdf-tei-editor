#!/usr/bin/env python3
"""
Export files from hash-sharded storage to human-readable directory structure.

Usage:
    python bin/export_files.py export/
    python bin/export_files.py --collections=corpus1,corpus2 export/
    python bin/export_files.py --variants="grobid*" --group-by=variant export/
    python bin/export_files.py --versions --group-by=collection export/
"""

import argparse
from pathlib import Path
import sys
import logging

# Add fastapi_app to Python path
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_exporter import FileExporter
from fastapi_app.config import get_settings

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(
        description='Export files from hash-sharded storage to human-readable directories',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Export all gold files with default grouping (by collection)
  python bin/export_files.py export/

  # Export specific collections
  python bin/export_files.py --collections=corpus1,corpus2 export/

  # Export all grobid variants using glob pattern
  python bin/export_files.py --variants="grobid*" export/

  # Export with versions included
  python bin/export_files.py --versions export/

  # Group by collection instead of type
  python bin/export_files.py --group-by=collection export/

  # Group by variant (PDFs in pdf/, TEI files in variant dirs)
  python bin/export_files.py --group-by=variant export/

  # Filter filenames with regex
  python bin/export_files.py --regex="^10\\.1111" export/

  # Transform filenames (remove DOI prefix)
  python bin/export_files.py --transform-filename="/^10\\.\\d+__//" export/

  # Multiple transforms applied sequentially
  python bin/export_files.py --transform-filename="/^10\\.\\d+__//" --transform-filename="/__/-/" export/

  # Dry-run to preview without exporting
  python bin/export_files.py --dry-run export/

Grouping Strategies:
  collection (default): export/corpus1/, export/corpus2/, ...
  type:                 export/pdf/, export/tei/, export/versions/
  variant:              export/pdf/, export/grobid-0.8.1/, export/metatei/, ...

Filename Format:
  PDFs:               <doc_id>.pdf
  Gold TEI (variant): <doc_id>.<variant>.tei.xml
  Gold TEI (no var):  <doc_id>.tei.xml
  Versioned TEI:      <doc_id>.<variant>-v<N>.tei.xml

  Note: Forward slashes in doc_id are encoded as __ (double underscore)
        Other special chars are encoded as $XX$ (hex code)
        """
    )
    parser.add_argument('target_path', help='Target directory for export')
    parser.add_argument('--collections', help='Comma-separated list of collections to export')
    parser.add_argument('--variants', help='Comma-separated list of variants to export (supports glob patterns like "grobid*")')
    parser.add_argument('--regex', help='Regular expression to filter filenames')
    parser.add_argument('--versions', action='store_true',
                       help='Include versioned TEI files (default: only gold files)')
    parser.add_argument('--group-by', choices=['type', 'collection', 'variant'], default='collection',
                       help='Directory grouping strategy (default: collection)')
    parser.add_argument('--transform-filename', metavar='EXPR', action='append',
                       help='sed-style filename transformation (/search/replace/), can be specified multiple times')
    parser.add_argument('--db-path', help='Database path (default: data/db/metadata.db)')
    parser.add_argument('--storage-root', help='Storage root (default: data/files)')
    parser.add_argument('--dry-run', action='store_true',
                       help='Preview without exporting')
    parser.add_argument('--verbose', '-v', action='store_true',
                       help='Enable verbose logging')
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Get paths from settings or args
    settings = get_settings()
    db_path = Path(args.db_path) if args.db_path else (settings.data_root / "db" / "metadata.db")
    storage_root = Path(args.storage_root) if args.storage_root else (settings.data_root / "files")
    target_path = Path(args.target_path)

    # Validate database exists
    if not db_path.exists():
        logger.error(f"Database does not exist: {db_path}")
        sys.exit(1)

    # Validate storage root exists
    if not storage_root.exists():
        logger.error(f"Storage root does not exist: {storage_root}")
        sys.exit(1)

    # Parse collections
    collections = None
    if args.collections:
        collections = [c.strip() for c in args.collections.split(',')]

    # Parse variants
    variants = None
    if args.variants:
        variants = [v.strip() for v in args.variants.split(',')]

    # Initialize components
    logger.info(f"Database: {db_path}")
    logger.info(f"Storage: {storage_root}")
    logger.info(f"Target: {target_path}")

    db = DatabaseManager(db_path, logger)
    storage = FileStorage(storage_root, db_path, logger)
    repo = FileRepository(db, logger)

    # Create exporter
    exporter = FileExporter(db, storage, repo, args.dry_run)

    # Log export configuration
    logger.info(f"Group by: {args.group_by}")
    if collections:
        logger.info(f"Collections: {', '.join(collections)}")
    else:
        logger.info("Collections: all")
    if variants:
        logger.info(f"Variants: {', '.join(variants)}")
    if args.regex:
        logger.info(f"Regex filter: {args.regex}")
    if args.transform_filename:
        logger.info(f"Filename transforms: {', '.join(args.transform_filename)}")
    logger.info(f"Include versions: {args.versions}")
    if args.dry_run:
        logger.info("[DRY RUN MODE - No files will be exported]")

    # Export
    try:
        stats = exporter.export_files(
            target_path=target_path,
            collections=collections,
            variants=variants,
            regex=args.regex,
            include_versions=args.versions,
            group_by=args.group_by,
            filename_transforms=args.transform_filename
        )
    except ValueError as e:
        logger.error(f"Invalid parameters: {e}")
        sys.exit(1)
    except Exception as e:
        logger.error(f"Export failed: {e}", exc_info=True)
        sys.exit(1)

    # Report
    print("\n" + "="*60)
    print("Export Summary")
    print("="*60)
    print(f"  Files scanned:  {stats['files_scanned']}")
    print(f"  Files exported: {stats['files_exported']}")
    print(f"  Files skipped:  {stats['files_skipped']}")
    print(f"  Errors:         {len(stats['errors'])}")
    print("="*60)

    if stats['errors']:
        print("\nErrors:")
        for error in stats['errors'][:10]:  # Show first 10 errors
            file_id = error.get('file_id', 'unknown')
            filename = error.get('filename', 'unknown')
            err_msg = error.get('error', 'unknown error')
            print(f"  {filename} ({file_id[:8]}...): {err_msg}")
        if len(stats['errors']) > 10:
            print(f"  ... and {len(stats['errors']) - 10} more errors")

    # Exit with error code if there were errors
    if stats['errors']:
        sys.exit(1)


if __name__ == '__main__':
    main()
