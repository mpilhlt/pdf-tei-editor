#!/usr/bin/env python3
"""
Migrate existing TEI documents to include biblStruct in sourceDesc.

This script retrofits TEI documents created before the biblStruct enhancement
with structured journal metadata.

Usage:
    uv run python bin/migrate-tei-biblstruct.py [--dry-run] [--limit N] [--force]

Options:
    --dry-run    Show what would be changed without saving
    --limit N    Process only N documents (for testing)
    --force      Overwrite existing biblStruct elements (regenerate from metadata)
"""

import sys
import argparse
import logging
from pathlib import Path
from lxml import etree

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from fastapi_app.config import get_settings
from fastapi_app.lib.database import DatabaseManager
from fastapi_app.lib.file_repository import FileRepository
from fastapi_app.lib.file_storage import FileStorage
from fastapi_app.lib.tei_utils import (
    extract_tei_metadata,
    serialize_tei_with_formatted_header,
    extract_processing_instructions
)


def has_biblstruct(tei_root: etree._Element) -> bool:
    """Check if TEI document already has biblStruct in sourceDesc."""
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    biblStruct = tei_root.find('.//tei:sourceDesc/tei:biblStruct', ns)
    return biblStruct is not None


def add_biblstruct_to_tei_header(tei_root: etree._Element) -> bool:
    """
    Add biblStruct to TEI document header using existing metadata from teiHeader.

    Args:
        tei_root: TEI root element

    Returns:
        True if biblStruct was added, False if no metadata available
    """
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}

    # Extract metadata from existing teiHeader elements
    metadata = extract_tei_metadata(tei_root)

    # Check if we have enough metadata to create biblStruct
    has_content = (
        metadata.get('title') or
        metadata.get('journal') or
        metadata.get('authors')
    )

    if not has_content:
        return False

    # Find sourceDesc
    sourceDesc = tei_root.find('.//tei:sourceDesc', ns)
    if sourceDesc is None:
        return False

    # Build biblStruct
    biblStruct = etree.Element("{http://www.tei-c.org/ns/1.0}biblStruct")

    # Analytic section (article-level metadata)
    title = metadata.get('title')
    authors = metadata.get('authors', [])

    if title or authors:
        analytic = etree.SubElement(biblStruct, "{http://www.tei-c.org/ns/1.0}analytic")

        if title:
            title_elem = etree.SubElement(analytic, "{http://www.tei-c.org/ns/1.0}title")
            title_elem.set("level", "a")
            title_elem.text = title

        # Add authors to analytic section
        for author in authors:
            author_elem = etree.SubElement(analytic, "{http://www.tei-c.org/ns/1.0}author")
            persName = etree.SubElement(author_elem, "{http://www.tei-c.org/ns/1.0}persName")
            if author.get("given"):
                forename = etree.SubElement(persName, "{http://www.tei-c.org/ns/1.0}forename")
                forename.text = author["given"]
            if author.get("family"):
                surname = etree.SubElement(persName, "{http://www.tei-c.org/ns/1.0}surname")
                surname.text = author["family"]

    # Monograph section (journal-level metadata)
    journal = metadata.get('journal')
    volume = metadata.get('volume')
    issue = metadata.get('issue')
    pages = metadata.get('pages')
    date = metadata.get('date')
    publisher = metadata.get('publisher')

    if journal or publisher or date or volume or issue or pages:
        monogr = etree.SubElement(biblStruct, "{http://www.tei-c.org/ns/1.0}monogr")

        if journal:
            journal_elem = etree.SubElement(monogr, "{http://www.tei-c.org/ns/1.0}title")
            journal_elem.set("level", "j")
            journal_elem.text = journal

        # Imprint section
        imprint = etree.SubElement(monogr, "{http://www.tei-c.org/ns/1.0}imprint")

        if volume:
            vol_elem = etree.SubElement(imprint, "{http://www.tei-c.org/ns/1.0}biblScope")
            vol_elem.set("unit", "volume")
            vol_elem.text = volume

        if issue:
            issue_elem = etree.SubElement(imprint, "{http://www.tei-c.org/ns/1.0}biblScope")
            issue_elem.set("unit", "issue")
            issue_elem.text = issue

        if pages:
            pages_elem = etree.SubElement(imprint, "{http://www.tei-c.org/ns/1.0}biblScope")
            pages_elem.set("unit", "page")
            # Parse page range
            if "-" in pages:
                parts = pages.split("-")
                if len(parts) == 2:
                    pages_elem.set("from", parts[0].strip())
                    pages_elem.set("to", parts[1].strip())
            pages_elem.text = pages

        if date:
            date_elem = etree.SubElement(imprint, "{http://www.tei-c.org/ns/1.0}date")
            date_elem.set("when", str(date))
            date_elem.text = str(date)

        if publisher:
            pub_elem = etree.SubElement(imprint, "{http://www.tei-c.org/ns/1.0}publisher")
            pub_elem.text = publisher

    # Add identifiers and URLs at biblStruct level
    doi = metadata.get('doi')
    id_value = metadata.get('id')
    url = metadata.get('url')

    if doi:
        idno = etree.SubElement(biblStruct, "{http://www.tei-c.org/ns/1.0}idno")
        idno.set("type", "DOI")
        idno.text = doi
    elif id_value:
        idno = etree.SubElement(biblStruct, "{http://www.tei-c.org/ns/1.0}idno")
        if ":" in id_value:
            id_type = id_value.split(":")[0]
            idno.set("type", id_type)
            idno.text = id_value[len(id_type) + 1:]
        else:
            idno.text = id_value

    if url:
        ptr = etree.SubElement(biblStruct, "{http://www.tei-c.org/ns/1.0}ptr")
        ptr.set("target", url)

    # Insert biblStruct after bibl (if exists) or at end of sourceDesc
    bibl = sourceDesc.find('tei:bibl', ns)
    if bibl is not None:
        # Insert after bibl
        bibl_index = list(sourceDesc).index(bibl)

        # Determine indentation by examining bibl's position
        # bibl.tail is the text after </bibl> which should already have proper indentation
        original_bibl_tail = bibl.tail

        # Set bibl.tail to provide indentation for biblStruct (should match bibl's own indentation)
        # Typical indentation for sourceDesc children is 8 spaces (2 levels deep)
        bibl.tail = "\n        "  # newline + 8 spaces for biblStruct opening tag

        # Set biblStruct.tail to provide indentation for sourceDesc closing tag
        # This should match the parent indentation (6 spaces)
        biblStruct.tail = "\n      " if original_bibl_tail is None else original_bibl_tail

        sourceDesc.insert(bibl_index + 1, biblStruct)
    else:
        # Append to end
        # First child of sourceDesc, add indentation
        if sourceDesc.text is None:
            sourceDesc.text = "\n        "  # Indent for first child
        biblStruct.tail = "\n      "  # Closing tag indentation for sourceDesc
        sourceDesc.append(biblStruct)

    # Add proper indentation to biblStruct and its children
    # Base indentation for biblStruct children (they're 3 levels deep, so 4 spaces relative to biblStruct)
    try:
        etree.indent(biblStruct, space="  ", level=4)
    except (AttributeError, TypeError):
        # etree.indent not available or doesn't support level parameter in older lxml versions
        try:
            etree.indent(biblStruct, space="  ")
        except AttributeError:
            pass

    return True


def migrate_tei_files(dry_run: bool = False, limit: int = None, force: bool = False):
    """
    Migrate all TEI files to include biblStruct.

    Args:
        dry_run: If True, don't save changes
        limit: Maximum number of files to process (for testing)
        force: If True, overwrite existing biblStruct elements
    """
    settings = get_settings()
    logger = logging.getLogger(__name__)

    # Initialize database and storage
    metadata_db_path = settings.db_dir / "metadata.db"
    db_manager = DatabaseManager(metadata_db_path)
    file_repo = FileRepository(db_manager)
    storage_root = settings.data_root / "files"
    file_storage = FileStorage(storage_root, db_manager, logger)

    # Get all TEI files
    try:
        all_files = file_repo.list_files(file_type="tei")
    except Exception as e:
        logger.error(f"Failed to query database: {e}")
        return

    logger.info(f"Found {len(all_files)} TEI files in database")

    if limit:
        all_files = all_files[:limit]
        logger.info(f"Limited to {limit} files for testing")

    processed = 0
    migrated = 0
    skipped = 0
    errors = 0

    for file_obj in all_files:
        processed += 1
        stable_id = file_obj.stable_id
        file_id = file_obj.id  # Current content hash

        try:
            # Load TEI content
            content = file_storage.read_file(file_id, "tei")
            if not content:
                logger.warning(f"File {stable_id} not found in storage (file_id: {file_id})")
                errors += 1
                continue

            # Parse TEI
            tei_root = etree.fromstring(content)

            # Namespace for XPath queries
            ns = {"tei": "http://www.tei-c.org/ns/1.0"}

            # Check if already has biblStruct
            already_has_biblstruct = has_biblstruct(tei_root)
            if already_has_biblstruct and not force:
                logger.debug(f"Skipping {stable_id} - already has biblStruct (use --force to overwrite)")
                skipped += 1
                continue

            # If force mode and biblStruct exists, remove it first
            if force and already_has_biblstruct:
                sourceDesc = tei_root.find('.//tei:sourceDesc', ns)
                if sourceDesc is not None:
                    existing_biblstruct = sourceDesc.find('tei:biblStruct', ns)
                    if existing_biblstruct is not None:
                        sourceDesc.remove(existing_biblstruct)
                        logger.debug(f"Removed existing biblStruct from {stable_id}")

            # Extract processing instructions before modification
            processing_instructions = extract_processing_instructions(content.decode('utf-8'))

            # Add biblStruct
            added = add_biblstruct_to_tei_header(tei_root)

            if not added:
                logger.info(f"Skipping {stable_id} - insufficient metadata for biblStruct")
                skipped += 1
                continue

            # Serialize updated TEI
            updated_xml = serialize_tei_with_formatted_header(tei_root, processing_instructions)

            action = "overwrite" if (force and already_has_biblstruct) else "add"

            if dry_run:
                logger.info(f"[DRY RUN] Would {action} biblStruct in {stable_id}")
                migrated += 1
            else:
                # Save to storage (gets new content hash)
                new_file_id, _ = file_storage.save_file(updated_xml.encode('utf-8'), "tei")

                # Update metadata.db with new file_id
                # Preserve all other metadata (stable_id, label, collections, etc.)
                from fastapi_app.lib.models import FileUpdate
                update = FileUpdate(id=new_file_id)

                # Verify record exists before updating (defensive check for database inconsistencies)
                try:
                    existing_record = file_repo.get_file_by_id(file_id)
                    if not existing_record:
                        logger.warning(f"Skipping {stable_id}: database record not found (file_id: {file_id[:8]}...)")
                        skipped += 1
                        continue

                    file_repo.update_file(file_id, update)  # Use old file_id to identify record

                    action_past = "Overwrote" if (force and already_has_biblstruct) else "Migrated"
                    logger.info(f"{action_past} {stable_id}: {file_id[:8]}... → {new_file_id[:8]}...")
                    migrated += 1
                except ValueError as ve:
                    logger.warning(f"Skipping {stable_id}: {ve}")
                    skipped += 1
                    continue

        except Exception as e:
            logger.error(f"Error processing {stable_id}: {e}", exc_info=True)
            errors += 1

    # Summary
    logger.info("=" * 60)
    logger.info("Migration Summary:")
    logger.info(f"  Total files processed: {processed}")
    logger.info(f"  Files migrated: {migrated}")
    logger.info(f"  Files skipped: {skipped}")
    logger.info(f"  Errors: {errors}")
    if dry_run:
        logger.info("  (DRY RUN - no changes saved)")


def main():
    parser = argparse.ArgumentParser(
        description="Migrate TEI documents to include biblStruct in sourceDesc"
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
        help="Overwrite existing biblStruct elements (regenerate from metadata)"
    )

    args = parser.parse_args()

    # Configure logging
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)8s] %(message)s"
    )

    migrate_tei_files(dry_run=args.dry_run, limit=args.limit, force=args.force)


if __name__ == "__main__":
    main()
