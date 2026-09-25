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

import re
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
from fastapi_app.lib.utils.doi_utils import encode_for_xml_id, normalize_legacy_encoding

TEI_NS = "http://www.tei-c.org/ns/1.0"
XML_NS = "http://www.w3.org/XML/1998/namespace"
NS = {"tei": TEI_NS}

_LEGACY_ENCODING_RE = re.compile(r'\$([0-9A-Fa-f]{2})\$')


def migrate_tei_content(xml_bytes: bytes, doc_id: str) -> tuple[bytes | None, str, str | None]:
    """
    Migrate a single TEI document.

    Returns (migrated_bytes, status, new_doc_id) where:
    - status is one of:
      - "updated": file was migrated
      - "already_migrated": fileDesc/@xml:id already present, editionStmt absent
      - "skipped:<reason>": cannot migrate
      - "error:<message>": parse error
    - new_doc_id is the normalized doc_id when legacy ``$XX$`` encoding was corrected,
      otherwise ``None``
    """
    # Use recover=True so lxml tolerates documents that already have an invalid
    # xml:id set by a previous partial migration run.
    parser = etree.XMLParser(recover=True)
    root = etree.fromstring(xml_bytes, parser)
    if root is None:
        return None, "error:failed to parse XML", None

    tei_header = root.find("{%s}teiHeader" % TEI_NS)
    if tei_header is None:
        return None, "skipped:no teiHeader", None

    file_desc = tei_header.find("{%s}fileDesc" % TEI_NS)
    if file_desc is None:
        return None, "skipped:no fileDesc", None

    existing_xml_id = file_desc.get("{%s}id" % XML_NS)
    edition_stmt = file_desc.find("{%s}editionStmt" % TEI_NS)

    # Normalize legacy $XX$ encoding in doc_id before use
    normalized_doc_id = normalize_legacy_encoding(doc_id) if doc_id else doc_id
    new_doc_id: str | None = normalized_doc_id if normalized_doc_id != doc_id else None

    # Determine file_id for xml:id
    file_id: str | None = None
    if existing_xml_id:
        # Re-encode using the canonical source (normalized doc_id or fileref idno).
        # The existing value may be incorrect from a previous partial migration.
        source_id: str | None = None
        if edition_stmt is not None:
            idno = edition_stmt.find(".//{%s}idno[@type='fileref']" % TEI_NS)
            if idno is not None and idno.text:
                source_id = idno.text.strip()
        if not source_id:
            source_id = normalized_doc_id
        if not source_id:
            return None, "skipped:no fileref or doc_id", None
        corrected = encode_for_xml_id(source_id)
        if corrected == existing_xml_id and edition_stmt is None:
            return None, "already_migrated", None
        file_id = source_id
        set_xml_id = True
    else:
        set_xml_id = True
        if edition_stmt is not None:
            idno = edition_stmt.find(".//{%s}idno[@type='fileref']" % TEI_NS)
            if idno is not None and idno.text:
                raw = idno.text.strip()
                normalized = normalize_legacy_encoding(raw)
                if normalized != raw:
                    idno.text = normalized
                file_id = normalized
        if not file_id:
            if normalized_doc_id:
                file_id = normalized_doc_id
            else:
                return None, "skipped:no fileref or doc_id", None

    if set_xml_id and file_id:
        file_desc.set("{%s}id" % XML_NS, encode_for_xml_id(file_id))

    if edition_stmt is not None:
        # Copy edition/title to first revisionDesc/change as note[@type="label"]
        edition_title_elem = edition_stmt.find(".//{%s}edition/{%s}title" % (TEI_NS, TEI_NS))
        if edition_title_elem is not None and edition_title_elem.text:
            revision_desc = tei_header.find("{%s}revisionDesc" % TEI_NS)
            if revision_desc is not None:
                first_change = revision_desc.find("{%s}change" % TEI_NS)
                if first_change is not None:
                    # Only add if no label note already present
                    existing_label = first_change.find(
                        "{%s}note[@type='label']" % TEI_NS
                    )
                    if existing_label is None:
                        note = etree.SubElement(first_change, "{%s}note" % TEI_NS)
                        note.set("type", "label")
                        note.text = edition_title_elem.text.strip()
                        # Move note to be first child
                        first_change.remove(note)
                        first_change.insert(0, note)

        file_desc.remove(edition_stmt)

    migrated_xml = serialize_tei_with_formatted_header(root, [])
    return migrated_xml.encode("utf-8"), "updated", new_doc_id


def run_migration(dry_run: bool = False, limit: int | None = None) -> None:
    logger = logging.getLogger(__name__)
    settings = get_settings()

    metadata_db_path = settings.db_dir / "metadata.db"
    db_manager = DatabaseManager(metadata_db_path)
    file_repo = FileRepository(db_manager)
    storage_root = settings.data_root / "files"
    file_storage = FileStorage(storage_root, db_manager, logger)

    # Pass 1: normalize legacy $XX$ doc_ids for non-TEI files (e.g. PDFs)
    non_tei_files = [f for f in file_repo.list_files() if f.file_type != "tei"]
    doc_id_renames: dict[str, int] = {"updated": 0}
    for file_meta in non_tei_files:
        if not file_meta.doc_id or _LEGACY_ENCODING_RE.search(file_meta.doc_id) is None:
            continue
        new_doc_id = normalize_legacy_encoding(file_meta.doc_id)
        logger.info("Normalizing doc_id for %s file %s: %s → %s",
                    file_meta.file_type, file_meta.stable_id, file_meta.doc_id, new_doc_id)
        if not dry_run:
            try:
                file_repo.update_file(file_meta.id, FileUpdate(doc_id=new_doc_id))
            except Exception as e:
                logger.error("Failed to update doc_id for %s: %s", file_meta.stable_id, e)
                continue
        doc_id_renames["updated"] += 1

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

        migrated_bytes, status, new_doc_id = migrate_tei_content(xml_bytes, file_meta.doc_id or "")

        if status == "already_migrated":
            logger.debug("Already migrated: %s", label)
            stats["already_migrated"] += 1

        elif status == "updated":
            if new_doc_id:
                logger.info("Migrating (doc_id re-encoded: %s → %s): %s", file_meta.doc_id, new_doc_id, label)
            else:
                logger.info("Migrating: %s", label)
            if not dry_run:
                new_hash, _ = file_storage.save_file(migrated_bytes, "tei", increment_ref=False)
                db_update = FileUpdate(file_size=len(migrated_bytes))
                if new_hash != file_meta.id:
                    db_update.id = new_hash
                if new_doc_id:
                    db_update.doc_id = new_doc_id
                try:
                    file_repo.update_file(file_meta.id, db_update)
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
    print(f"Non-TEI doc_id re-encoded : {doc_id_renames['updated']}")
    print(f"TEI files processed       : {len(tei_files)}")
    print(f"  Updated                 : {stats['updated']}")
    print(f"  Already migrated        : {stats['already_migrated']}")
    print(f"  Skipped                 : {stats['skipped']}")
    print(f"  Errors                  : {stats['errors']}")


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
