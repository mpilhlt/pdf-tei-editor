#!/usr/bin/env python3
"""
Migrate TEI documents: move fileref from editionStmt to fileDesc/@xml:id.

For each TEI file in the database:
- Reads fileref from editionStmt/edition/idno[@type="fileref"] (or derives from doc_id)
- Sets fileDesc/@xml:id using encode_for_xml_id()
- Removes the <editionStmt> element
- Serializes back using serialize_tei_with_formatted_header()

Usage:
    uv run python bin/migrate-tei-fileref-to-xml-id.py [--dry-run] [--limit N]

Options:
    --dry-run    Show what would be changed without saving
    --limit N    Process only N TEI files (for testing)
"""

import sys
import argparse
import logging
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from lxml import etree

from fastapi_app.config import get_settings
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.models.models import FileUpdate
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.utils.tei_utils import serialize_tei_with_formatted_header
from fastapi_app.lib.utils.doi_utils import encode_for_xml_id

TEI_NS = "http://www.tei-c.org/ns/1.0"
XML_NS = "http://www.w3.org/XML/1998/namespace"
NS = {"tei": TEI_NS}


def migrate_tei_content(xml_bytes: bytes, doc_id: str) -> tuple[bytes | None, str]:
    """
    Migrate a single TEI document.

    Returns (migrated_bytes, status) where status is one of:
    - "updated": file was migrated
    - "already_migrated": fileDesc/@xml:id already present, editionStmt absent
    - "skipped:<reason>": cannot migrate
    - "error:<message>": parse error
    """
    try:
        root = etree.fromstring(xml_bytes)
    except etree.XMLSyntaxError as e:
        return None, f"error:{e}"

    tei_header = root.find("{%s}teiHeader" % TEI_NS)
    if tei_header is None:
        return None, "skipped:no teiHeader"

    file_desc = tei_header.find("{%s}fileDesc" % TEI_NS)
    if file_desc is None:
        return None, "skipped:no fileDesc"

    # Check if already migrated (has xml:id, no editionStmt)
    existing_xml_id = file_desc.get("{%s}id" % XML_NS)
    edition_stmt = file_desc.find("{%s}editionStmt" % TEI_NS)

    if existing_xml_id and edition_stmt is None:
        return None, "already_migrated"

    # Determine file_id for xml:id
    file_id: str | None = None
    if existing_xml_id:
        # Already encoded — don't re-encode
        set_xml_id = False
    else:
        set_xml_id = True
        if edition_stmt is not None:
            idno = edition_stmt.find(".//{%s}idno[@type='fileref']" % TEI_NS)
            if idno is not None and idno.text:
                file_id = idno.text.strip()
        if not file_id:
            if doc_id:
                file_id = doc_id
            else:
                return None, "skipped:no fileref or doc_id"

    if set_xml_id and file_id:
        file_desc.set("{%s}id" % XML_NS, encode_for_xml_id(file_id))

    if edition_stmt is not None:
        file_desc.remove(edition_stmt)

    migrated_xml = serialize_tei_with_formatted_header(root, [])
    return migrated_xml.encode("utf-8"), "updated"


def run_migration(dry_run: bool = False, limit: int | None = None) -> None:
    logger = logging.getLogger(__name__)
    settings = get_settings()

    metadata_db_path = settings.db_dir / "metadata.db"
    db_manager = DatabaseManager(metadata_db_path)
    file_repo = FileRepository(db_manager)
    storage_root = settings.data_root / "files"
    file_storage = FileStorage(storage_root, db_manager, logger)

    tei_files = file_repo.list_files(file_type="tei")
    if limit:
        tei_files = tei_files[:limit]

    stats: dict[str, int] = {"updated": 0, "already_migrated": 0, "skipped": 0, "errors": 0}

    for file_meta in tei_files:
        label = f"{file_meta.doc_id} (stable_id={file_meta.stable_id})"

        xml_bytes = file_storage.read_file(file_meta.id, "tei")
        if xml_bytes is None:
            logger.warning("Could not read TEI file: %s", label)
            stats["errors"] += 1
            continue

        migrated_bytes, status = migrate_tei_content(xml_bytes, file_meta.doc_id or "")

        if status == "already_migrated":
            logger.debug("Already migrated: %s", label)
            stats["already_migrated"] += 1

        elif status == "updated":
            logger.info("Migrating: %s", label)
            if not dry_run:
                new_hash, _ = file_storage.save_file(migrated_bytes, "tei", increment_ref=False)
                if new_hash != file_meta.id:
                    try:
                        file_repo.update_file(
                            file_meta.id,
                            FileUpdate(id=new_hash, file_size=len(migrated_bytes)),
                        )
                    except Exception as e:
                        logger.error("Failed to update DB record for %s: %s", label, e)
                        stats["errors"] += 1
                        continue
            stats["updated"] += 1

        elif status.startswith("skipped"):
            logger.warning("Skipped (%s): %s", status, label)
            stats["skipped"] += 1

        else:  # error:...
            logger.error("Error (%s): %s", status, label)
            stats["errors"] += 1

    print("=" * 60)
    if dry_run:
        print("DRY RUN — no files written")
    print(f"TEI files processed : {len(tei_files)}")
    print(f"  Updated           : {stats['updated']}")
    print(f"  Already migrated  : {stats['already_migrated']}")
    print(f"  Skipped           : {stats['skipped']}")
    print(f"  Errors            : {stats['errors']}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Migrate TEI fileref from editionStmt to fileDesc/@xml:id"
    )
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be changed without saving")
    parser.add_argument("--limit", type=int,
                        help="Process only N TEI files (for testing)")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Enable verbose logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s"
    )

    run_migration(dry_run=args.dry_run, limit=args.limit)


if __name__ == "__main__":
    main()
