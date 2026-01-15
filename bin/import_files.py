#!/usr/bin/env python3
"""
Import PDF and XML files from any directory into FastAPI database.

Usage:
    python bin/import_files.py demo/data --collection example
    python bin/import_files.py /path/to/files --collection my_collection --dry-run
    python bin/import_files.py /path/to/files --gold-pattern '\\.gold\\.'
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
from fastapi_app.lib.file_zip_importer import FileZipImporter
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

  # Use filename pattern for gold standard detection
  python bin/import_files.py /path/to/files --gold-pattern '\\.gold\\.'
  # Files like 'xyz.gold.tei.xml' marked as gold, doc_id becomes 'xyz.tei.xml'

  python bin/import_files.py /path/to/files --gold-pattern '_gold_'
  # Files like 'xyz_gold_file.tei.xml' marked as gold, doc_id becomes 'xyzfile.tei.xml'

  Note: By default, *.tei.xml files in a directory called "tei" are treated as gold files.
  Use --gold-pattern to customize gold detection via regex matching on path or filename.

        """
    )
    parser.add_argument('directory',
                       help='Directory or zip file containing PDF and XML files')
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
    parser.add_argument('--gold-dir-name', default=None,
                       help='Name of directory containing gold standard files. '
                            'Only used if --gold-pattern is not specified. '
                            'If neither --gold-pattern nor --gold-dir-name is provided, '
                            'files without .vN. version markers are treated as gold (default behavior).')
    parser.add_argument('--gold-pattern',
                       help='Regular expression pattern to detect gold standard files. '
                            'Can match either the full path or filename. If matched in filename, '
                            'the pattern is stripped before parsing doc_id. '
                            'Examples: r\'\\.gold\\.\' for .gold. in name, r\'_gold_\' for _gold_ in name. '
                            'Default: matches files in directory with name from --gold-dir-name.')
    parser.add_argument('--version-pattern',
                       help='Regular expression pattern to detect and strip version markers from filenames '
                            'for matching purposes. Allows multiple versions of a file to match with the same PDF. '
                            'Examples: r\'\\.version\\d+\\.\' for .version1., .version2., etc.; '
                            'r\'-v\\d+-\' for -v1-, -v2-, etc. '
                            'Default: None (no version pattern stripping).')
    parser.add_argument('--verbose', '-v', action='store_true',
                       help='Enable verbose logging')
    parser.add_argument('--zip', action='store_true',
                       help='Treat directory argument as a zip file to import')
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Get paths from settings or args
    settings = get_settings()
    db_path = Path(args.db_path) if args.db_path else (settings.data_root / "metadata.db")
    storage_root = Path(args.storage_root) if args.storage_root else (settings.data_root / "files")
    directory = Path(args.directory)

    # Validate directory or zip file
    if not directory.exists():
        logger.error(f"Path does not exist: {directory}")
        sys.exit(1)

    if args.zip:
        if not directory.is_file():
            logger.error(f"Not a file: {directory}")
            sys.exit(1)
        if not directory.suffix == '.zip':
            logger.error(f"Not a zip file: {directory}")
            sys.exit(1)
    else:
        if not directory.is_dir():
            logger.error(f"Not a directory: {directory}")
            sys.exit(1)

    # Initialize components
    logger.info(f"Database: {db_path}")
    logger.info(f"Storage: {storage_root}")

    db = DatabaseManager(db_path, logger)
    storage = FileStorage(storage_root, db, logger)
    repo = FileRepository(db)

    # Clean database if requested
    if args.clean:
        if args.dry_run:
            logger.info("[DRY RUN] Would clear all data from database")
        else:
            logger.warning("Clearing all data from database...")
            db.clear_all_data()

    # Import from zip or directory
    if args.zip:
        # Import from zip file
        logger.info(f"Importing from zip file: {directory}")

        zip_importer = FileZipImporter(db, storage, repo, args.dry_run)

        if args.gold_pattern:
            logger.info(f"Gold standard pattern: {args.gold_pattern}")
        elif args.gold_dir_name:
            logger.info(f"Gold standard directory: {args.gold_dir_name}")
        else:
            logger.info("Gold standard detection: files without .vN. version markers")
        if args.version_pattern:
            logger.info(f"Version pattern: {args.version_pattern}")
        if args.recursive_collections:
            logger.info("Using subdirectory names as collection names")
            logger.info(f"Skipping directories: {', '.join(args.skip_dirs)}")
            logger.info("Files in root directory will have no collection")
        elif args.collection:
            logger.info(f"Collection: {args.collection}")
        if args.dry_run:
            logger.info("[DRY RUN MODE - No changes will be made]")

        skip_dirs = args.skip_dirs if args.recursive_collections else None
        stats = zip_importer.import_from_zip(
            zip_path=directory,
            collection=args.collection,
            recursive_collections=args.recursive_collections,
            skip_dirs=skip_dirs,
            gold_dir_name=args.gold_dir_name,
            gold_pattern=args.gold_pattern,
            version_pattern=args.version_pattern
        )
        zip_importer.cleanup()
    else:
        # Import from directory
        # Pass skip_dirs only if recursive_collections is enabled
        skip_dirs = args.skip_dirs if args.recursive_collections else None
        importer = FileImporter(
            db, storage, repo, args.dry_run, skip_dirs,
            args.gold_dir_name, args.gold_pattern, args.version_pattern
        )

        logger.info(f"Importing from directory: {directory}")
        if args.gold_pattern:
            logger.info(f"Gold standard pattern: {args.gold_pattern}")
        elif args.gold_dir_name:
            logger.info(f"Gold standard directory: {args.gold_dir_name}")
        else:
            logger.info("Gold standard detection: files without .vN. version markers")
        if args.version_pattern:
            logger.info(f"Version pattern: {args.version_pattern}")
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
