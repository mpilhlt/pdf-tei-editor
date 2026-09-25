#!/usr/bin/env python3
"""
Rename a GROBID processing flavor value across all stored TEI documents.

Rewrites the text of
  TEI/teiHeader/encodingDesc/appInfo/application[@type="extractor"]/label[@type="flavor"]
from <old-flavor> to <new-flavor> in every TEI file in the database, saves the
rewritten content to content-addressed storage, and repoints the file records
at the new content hash. FileRepository.update_file() marks the affected
records sync_status='modified' so the sync engine re-uploads them.

This is a one-off data migration (see docs/development/migrations.md "Data
Migrations vs. Schema Migrations"), not part of the auto-run schema-migration
framework. It is idempotent: a second run reports already-migrated files and
changes nothing.

Usage:
    uv run python bin/migrate-tei-flavor-rename.py <old-flavor> <new-flavor> [options]

Options:
    --dry-run     Show what would change without writing
    --limit N     Process at most N distinct TEI content hashes (for testing)
    -v/--verbose  Enable debug logging

Example:
    uv run python bin/migrate-tei-flavor-rename.py \\
        article/dh-law-footnotes article/footnotes-refs --dry-run
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

TEI_NS = "http://www.tei-c.org/ns/1.0"

_FLAVOR_XPATHS = (
    ".//tei:application[@type='extractor']//tei:label[@type='flavor']",
    ".//application[@type='extractor']//label[@type='flavor']",
)


def _find_flavor_labels(root: "etree._Element") -> list["etree._Element"]:  # type: ignore[name-defined]
    """Return every extractor flavor <label> element, namespaced or not."""
    for xpath in _FLAVOR_XPATHS:
        try:
            found = root.xpath(xpath, namespaces={"tei": TEI_NS})
        except etree.XPathEvalError:
            found = []
        if found:
            return list(found)
    return []


def rename_flavor_in_tei(
    xml_bytes: bytes, old_flavor: str, new_flavor: str
) -> tuple[bytes | None, str]:
    """
    Rewrite the flavor label value in a single TEI document.

    Returns (new_bytes, status) where status is one of:
      - "updated"                     flavor label held old_flavor; new_bytes set
      - "updated:extra-occurrences:N" as "updated", plus N occurrences of the
                                      old_flavor token outside the flavor
                                      label(s) were rewritten too (e.g. the
                                      "<variant> [<flavor>]" note that
                                      revisionDesc/change carries)
      - "already_migrated"            flavor label already holds new_flavor
      - "skipped:no-flavor-label"     no extractor flavor label present
      - "skipped:other-flavor:X"      flavor label holds unrelated value(s) X
      - "error:<message>"             parse error

    The old_flavor token is a specific compound string that only ever names
    this one flavor, so a whole-document text replacement is safe.
    """
    parser = etree.XMLParser(recover=True)
    try:
        root = etree.fromstring(xml_bytes, parser)
    except etree.XMLSyntaxError as exc:
        return None, f"error:parse failed: {exc}"
    if root is None:
        return None, "error:parse failed: empty tree"

    labels = _find_flavor_labels(root)
    if not labels:
        return None, "skipped:no-flavor-label"

    values = {(lbl.text or "").strip() for lbl in labels}
    if values == {new_flavor}:
        return None, "already_migrated"
    if old_flavor not in values:
        return None, "skipped:other-flavor:" + ",".join(sorted(v for v in values if v))

    xml_text = xml_bytes.decode("utf-8")
    literal_count = xml_text.count(old_flavor)
    labels_with_old = sum(
        1 for lbl in labels if (lbl.text or "").strip() == old_flavor
    )

    new_bytes = xml_text.replace(old_flavor, new_flavor).encode("utf-8")
    extra = literal_count - labels_with_old
    if extra > 0:
        return new_bytes, f"updated:extra-occurrences:{extra}"
    return new_bytes, "updated"


def run_migration(
    old_flavor: str,
    new_flavor: str,
    dry_run: bool = False,
    limit: int | None = None,
) -> None:
    logger = logging.getLogger(__name__)
    settings = get_settings()

    db = DatabaseManager(settings.db_dir / "metadata.db")
    file_repo = FileRepository(db)
    file_storage = FileStorage(settings.data_root / "files", db, logger)

    tei_files = file_repo.list_files(file_type="tei")

    # Deduplicate by content hash; keep one record per hash for logging context.
    by_hash: dict[str, object] = {}
    for fm in tei_files:
        by_hash.setdefault(fm.id, fm)

    hashes = list(by_hash.items())
    if limit:
        hashes = hashes[:limit]

    stats = {"updated": 0, "already_migrated": 0, "skipped": 0, "errors": 0}

    for old_id, fm in hashes:
        label = (
            f"{getattr(fm, 'doc_id', '?')} "
            f"(stable_id={getattr(fm, 'stable_id', '?')}, hash={old_id[:8]})"
        )

        xml_bytes = file_storage.read_file(old_id, "tei")
        if xml_bytes is None:
            logger.warning("Could not read TEI content: %s", label)
            stats["errors"] += 1
            continue

        new_bytes, status = rename_flavor_in_tei(xml_bytes, old_flavor, new_flavor)

        if status == "already_migrated":
            logger.debug("Already migrated: %s", label)
            stats["already_migrated"] += 1
        elif status == "updated" or status.startswith("updated:extra-occurrences:"):
            if status != "updated":
                extra = status.rsplit(":", 1)[1]
                logger.info(
                    "Renaming flavor (+%s occurrence(s) outside the flavor label, "
                    "e.g. revisionDesc note): %s",
                    extra,
                    label,
                )
            else:
                logger.info("Renaming flavor: %s", label)
            if not dry_run:
                assert new_bytes is not None
                new_hash, _ = file_storage.save_file(
                    new_bytes, "tei", increment_ref=False
                )
                try:
                    file_repo.update_file(
                        old_id, FileUpdate(id=new_hash, file_size=len(new_bytes))
                    )
                except Exception as exc:  # noqa: BLE001 - report and continue
                    logger.error("DB update failed for %s: %s", label, exc)
                    stats["errors"] += 1
                    continue
            stats["updated"] += 1
        elif status.startswith("skipped"):
            logger.debug("Skipped (%s): %s", status, label)
            stats["skipped"] += 1
        else:
            logger.error("Error (%s): %s", status, label)
            stats["errors"] += 1

    print("=" * 60)
    if dry_run:
        print("DRY RUN - no files written")
    print(f"Flavor rename       : {old_flavor!r} -> {new_flavor!r}")
    print(f"Distinct TEI hashes : {len(hashes)}")
    print(f"  Updated           : {stats['updated']}")
    print(f"  Already migrated  : {stats['already_migrated']}")
    print(f"  Skipped           : {stats['skipped']}")
    print(f"  Errors            : {stats['errors']}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Rename a GROBID processing flavor value in all stored TEI documents"
    )
    parser.add_argument("old_flavor", help="Current flavor value to search for")
    parser.add_argument("new_flavor", help="Replacement flavor value")
    parser.add_argument(
        "--dry-run", action="store_true", help="Show changes without writing"
    )
    parser.add_argument(
        "--limit", type=int, help="Process at most N distinct TEI content hashes"
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="Enable debug logging"
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s: %(message)s",
    )

    run_migration(
        old_flavor=args.old_flavor,
        new_flavor=args.new_flavor,
        dry_run=args.dry_run,
        limit=args.limit,
    )


if __name__ == "__main__":
    main()
