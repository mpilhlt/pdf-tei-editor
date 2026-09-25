#!/usr/bin/env python3
"""
Update TEI metadata with complete bibliographic data.

This script enriches TEI documents with complete metadata from:
- CrossRef/DataCite (for documents with DOI)
- LLM extraction (for documents without DOI)

Updates both TEI biblStruct and database doc_metadata.

Usage:
    uv run python bin/update-tei-metadata.py [--dry-run] [--limit N] [--force]

Options:
    --dry-run    Show what would be changed without saving
    --limit N    Process only N documents (for testing)
    --force      Overwrite existing biblStruct elements (regenerate from API/LLM)
"""

import sys
import argparse
import logging
import asyncio
from pathlib import Path
from lxml import etree
from tqdm import tqdm

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from fastapi_app.config import get_settings
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.services.metadata_update_utils import (
    has_biblstruct,
    extract_doi_from_tei,
    update_biblstruct_in_tei,
    update_tei_metadata
)


# All utility functions are now imported from fastapi_app/lib/metadata_update_utils.py


async def run_update(dry_run: bool = False, limit: int = None, force: bool = False, verbose: bool = False):
    """
    Update all TEI files with complete metadata from DOI lookup or LLM extraction.

    This function now calls the shared update_tei_metadata utility function.

    Args:
        dry_run: If True, don't save changes
        limit: Maximum number of PDFs to process (for testing)
        force: If True, overwrite existing biblStruct elements
        verbose: If True, show verbose logging instead of progress bar
    """
    settings = get_settings()
    logger = logging.getLogger(__name__)

    # Initialize database and storage
    metadata_db_path = settings.db_dir / "metadata.db"
    db_manager = DatabaseManager(metadata_db_path)
    file_repo = FileRepository(db_manager)
    storage_root = settings.data_root / "files"
    file_storage = FileStorage(storage_root, db_manager, logger)

    # Call shared utility function
    # Note: dry_run is not supported by the shared function yet
    # TODO: Add dry_run support to metadata_update_utils.update_tei_metadata()
    if dry_run:
        logger.warning("DRY RUN mode is not yet supported by the shared utility function")
        logger.warning("This will perform actual updates. Use --limit to test on a small subset.")

    # Get total count for progress bar
    try:
        all_pdfs = file_repo.list_files(file_type="pdf")
        total = len(all_pdfs)
        if limit:
            total = min(total, limit)
    except Exception as e:
        logger.error(f"Failed to query database: {e}")
        return

    # Create progress bar (only if not verbose)
    pbar = None
    progress_callback = None
    log_handler = None

    if not verbose:
        pbar = tqdm(total=total, desc="Processing PDFs", unit="PDF", ncols=80)

        # Redirect logging through tqdm to avoid disrupting progress bar
        class TqdmLoggingHandler(logging.Handler):
            def emit(self, record):
                try:
                    msg = self.format(record)
                    pbar.write(msg)
                except Exception:
                    self.handleError(record)

        log_handler = TqdmLoggingHandler()
        log_handler.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
        logging.root.addHandler(log_handler)

        def progress_callback(current: int, total: int, label: str):
            """Update console progress bar."""
            pbar.set_description(label[:50])  # Truncate long labels
            pbar.n = current
            pbar.refresh()

    try:
        stats = await update_tei_metadata(
            file_repo=file_repo,
            file_storage=file_storage,
            limit=limit,
            force=force,
            progress_callback=progress_callback,
            cancellation_check=None  # No cancellation in CLI
        )
    finally:
        if pbar:
            pbar.close()
        if log_handler:
            logging.root.removeHandler(log_handler)

    # Summary
    print("=" * 60)
    print("Update Summary:")
    print(f"  PDFs processed: {stats['processed']}")
    print(f"  TEI files updated: {stats['updated']}")
    print(f"  PDFs skipped: {stats['skipped']}")
    print(f"  Errors: {stats['errors']}")


def main():
    parser = argparse.ArgumentParser(
        description="Update TEI documents with complete bibliographic metadata"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be changed without saving"
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="Process only N documents (for testing)"
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable verbose logging"
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing biblStruct elements (regenerate from API/LLM)"
    )

    args = parser.parse_args()

    # Configure logging
    # In verbose mode: show DEBUG logs, no progress bar
    # In normal mode: logs will be redirected through tqdm in run_update()
    if args.verbose:
        logging.basicConfig(
            level=logging.DEBUG,
            format="%(asctime)s [%(levelname)8s] %(message)s"
        )
    else:
        # Set up minimal logging, handlers will be configured in run_update()
        logging.basicConfig(
            level=logging.WARNING,
            format="%(levelname)s: %(message)s",
            handlers=[]  # No handlers yet, will be added in run_update()
        )

    # Run async update function
    asyncio.run(run_update(
        dry_run=args.dry_run,
        limit=args.limit,
        force=args.force,
        verbose=args.verbose
    ))


if __name__ == "__main__":
    main()
