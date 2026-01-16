#!/usr/bin/env python3
"""
Script to delete orphaned XML files (XML files with no corresponding PDF).

An orphaned XML file is one where:
- file_type = 'tei' (XML file)
- deleted = 0 (not soft-deleted)
- No non-deleted PDF exists with the same doc_id

Usage:
    uv run python bin/cleanup-orphaned-xml.py [--dry-run] [--db-path PATH]

Options:
    --dry-run    Show what would be deleted without actually deleting
    --db-path    Path to metadata.db (default: data/db/metadata.db)
"""

import argparse
import sqlite3
from pathlib import Path


def get_orphaned_xml_files(conn: sqlite3.Connection) -> list[dict]:
    """Find XML files that have no corresponding PDF for the same doc_id."""
    query = """
        SELECT xml.id, xml.stable_id, xml.doc_id, xml.filename, xml.variant, xml.file_size
        FROM files xml
        LEFT JOIN files pdf ON xml.doc_id = pdf.doc_id
            AND pdf.file_type = 'pdf'
            AND pdf.deleted = 0
        WHERE xml.file_type = 'tei'
            AND xml.deleted = 0
            AND pdf.id IS NULL
    """
    cursor = conn.cursor()
    cursor.execute(query)
    rows = cursor.fetchall()

    return [
        {
            'id': row[0],
            'stable_id': row[1],
            'doc_id': row[2],
            'filename': row[3],
            'variant': row[4],
            'file_size': row[5]
        }
        for row in rows
    ]


def delete_orphaned_xml_files(conn: sqlite3.Connection, dry_run: bool = True) -> dict:
    """Delete orphaned XML files from the database.

    Returns:
        dict with statistics: deleted_count, total_size
    """
    orphaned = get_orphaned_xml_files(conn)

    if not orphaned:
        print("No orphaned XML files found.")
        return {'deleted_count': 0, 'total_size': 0}

    print(f"Found {len(orphaned)} orphaned XML files:")
    total_size = 0

    for f in orphaned:
        size = f['file_size'] or 0
        total_size += size
        print(f"  {f['stable_id']} - {f['doc_id']} ({f['filename']}) - {size} bytes")

    print(f"\nTotal size: {total_size} bytes ({total_size / 1024:.1f} KB)")

    if dry_run:
        print("\n[DRY RUN] No files were deleted. Run without --dry-run to delete.")
        return {'deleted_count': 0, 'total_size': 0, 'would_delete': len(orphaned)}

    # Delete the records
    cursor = conn.cursor()
    deleted_count = 0

    for f in orphaned:
        try:
            cursor.execute("DELETE FROM files WHERE id = ?", (f['id'],))
            deleted_count += 1
            print(f"  Deleted: {f['stable_id']} ({f['doc_id']})")
        except Exception as e:
            print(f"  ERROR deleting {f['stable_id']}: {e}")

    conn.commit()

    print(f"\nDeleted {deleted_count} orphaned XML records from database.")
    print("NOTE: Physical files in storage were NOT deleted. Run garbage collection to clean storage.")

    return {'deleted_count': deleted_count, 'total_size': total_size}


def main():
    parser = argparse.ArgumentParser(
        description='Delete orphaned XML files (XML with no corresponding PDF)'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Show what would be deleted without actually deleting'
    )
    parser.add_argument(
        '--db-path',
        type=Path,
        default=Path('data/db/metadata.db'),
        help='Path to metadata.db (default: data/db/metadata.db)'
    )

    args = parser.parse_args()

    if not args.db_path.exists():
        print(f"ERROR: Database not found: {args.db_path}")
        return 1

    print(f"Database: {args.db_path}")
    print(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE (will delete)'}")
    print()

    conn = sqlite3.connect(args.db_path)
    try:
        result = delete_orphaned_xml_files(conn, dry_run=args.dry_run)
        return 0
    finally:
        conn.close()


if __name__ == '__main__':
    exit(main())
