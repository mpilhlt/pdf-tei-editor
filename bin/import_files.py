#!/usr/bin/env python3
"""
Import PDF and XML files from any directory into FastAPI database.

Usage:
    python bin/import_files.py demo/data --collection example
    python bin/import_files.py /path/to/files --collection my_collection --dry-run
"""

import argparse
from pathlib import Path
import sys
import os
import logging

# Add fastapi_app to Python path
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi_app.lib.database import DatabaseManager
from fastapi_app.lib.file_storage import FileStorage
from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.file_importer import FileImporter
from fastapi_app.config import get_settings

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser(
        description='Import files to FastAPI database',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Import demo data
  python bin/import_files.py demo/data --collection example

  # Import from arbitrary directory
  python bin/import_files.py /path/to/files --collection corpus1

  # Dry-run (preview without importing)
  python bin/import_files.py demo/data --collection example --dry-run

  # Import without assigning collection
  python bin/import_files.py /path/to/files

  # Import with automatic collection naming from subdirectories
  python bin/import_files.py /path/to/data --recursive-collections
  # Files in /path/to/data/corpus1/file.pdf -> collection "corpus1"
  # Files in /path/to/data/corpus1/pdf/file.pdf -> collection "corpus1" (skips "pdf" dir)
  # Files in /path/to/data/corpus2/tei/file.xml -> collection "corpus2" (skips "tei" dir)
  # Files in /path/to/data/file.pdf -> no collection
        """
    )
    parser.add_argument('directory',
                       help='Directory containing PDF and XML files')
    parser.add_argument('--collection', help='Collection name for imported files')
    parser.add_argument('--recursive-collections', action='store_true',
                       help='Use subdirectory names as collection names. '
                            'Files in <root>/<subdir>/ get collection "subdir". '
                            'Files in <root>/ have no collection. '
                            'Overrides --collection if both are specified.')
    parser.add_argument('--skip-dirs', nargs='+', default=['pdf', 'tei', 'versions', 'version'],
                       help='Directory names to skip when determining collections '
                            '(default: pdf tei versions version). Only used with --recursive-collections.')
    parser.add_argument('--db-path', help='Database path', default='data/db/metadata.db')
    parser.add_argument('--storage-root', help='Storage root', default='data/files')
    parser.add_argument('--dry-run', action='store_true',
                       help='Preview without importing')
    parser.add_argument('--no-recursive', action='store_true',
                       help='Do not scan subdirectories')
    parser.add_argument('--clean', action='store_true',
                       help='Clear all existing data from database before importing')
    parser.add_argument('--gold-dir-name', default='tei',
                       help='Name of directory containing gold standard files (default: tei)')
    parser.add_argument('--verbose', '-v', action='store_true',
                       help='Enable verbose logging')
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Get paths from settings or args
    settings = get_settings()
    db_path = Path(args.db_path) if args.db_path else (settings.data_root / "metadata.db")
    storage_root = Path(args.storage_root) if args.storage_root else (settings.data_root / "files")
    directory = Path(args.directory)

    # Validate directory
    if not directory.exists():
        logger.error(f"Directory does not exist: {directory}")
        sys.exit(1)

    if not directory.is_dir():
        logger.error(f"Not a directory: {directory}")
        sys.exit(1)

    # Initialize components
    logger.info(f"Database: {db_path}")
    logger.info(f"Storage: {storage_root}")

    db = DatabaseManager(db_path, logger)
    storage = FileStorage(storage_root, db_path, logger)
    repo = FileRepository(db)

    # Clean database if requested
    if args.clean:
        if args.dry_run:
            logger.info("[DRY RUN] Would clear all data from database")
        else:
            logger.warning("Clearing all data from database...")
            db.clear_all_data()

    # Pass skip_dirs only if recursive_collections is enabled
    skip_dirs = args.skip_dirs if args.recursive_collections else None
    importer = FileImporter(db, storage, repo, args.dry_run, skip_dirs, args.gold_dir_name)

    # Import
    logger.info(f"Importing from {directory}")
    logger.info(f"Gold standard directory: {args.gold_dir_name}")
    if args.recursive_collections:
        logger.info("Using subdirectory names as collection names")
        logger.info(f"Skipping directories: {', '.join(args.skip_dirs)}")
        logger.info("Files in root directory will have no collection")
    elif args.collection:
        logger.info(f"Collection: {args.collection}")
    if args.dry_run:
        logger.info("[DRY RUN MODE - No changes will be made]")

    recursive = not args.no_recursive
    stats = importer.import_directory(
        directory,
        args.collection,
        recursive,
        args.recursive_collections
    )

    # Report
    print("\n" + "="*60)
    print("Import Summary")
    print("="*60)
    print(f"  Files scanned:  {stats['files_scanned']}")
    print(f"  Files imported: {stats['files_imported']}")
    print(f"  Files skipped:  {stats['files_skipped']}")
    print(f"  Errors:         {len(stats['errors'])}")
    print("="*60)

    if stats['errors']:
        print("\nErrors:")
        for error in stats['errors'][:10]:  # Show first 10 errors
            print(f"  {error['doc_id']}: {error['error']}")
        if len(stats['errors']) > 10:
            print(f"  ... and {len(stats['errors']) - 10} more errors")

    # Exit with error code if there were errors
    if stats['errors']:
        sys.exit(1)


if __name__ == '__main__':
    main()
