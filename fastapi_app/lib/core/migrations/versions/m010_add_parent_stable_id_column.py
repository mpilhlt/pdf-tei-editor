"""
Migration 010: Add parent_stable_id column to files table

Records which version a TEI file was copied from, so that versions with descendants can be
frozen (see docs/history/2026-10-24-version-freeze.md). New versions get the column from the
save endpoint; for existing files it is derived from the revision history: the parent of a file
is the file of the same document and variant whose header changes (who, when, status) are the
longest proper prefix of the file's own changes. Ambiguous cases (several candidates with the
same changes) get no parent, so that no file is frozen by mistake.

Before: files has no parent_stable_id column.
After: files.parent_stable_id exists (indexed) and is set for existing versions with a unique
parent.
"""

import sqlite3
from collections import defaultdict
from typing import Optional

from fastapi_app.lib.core.migrations.base import Migration

Signature = tuple[str, str, str]


def find_parents(signatures: dict[str, list[Signature]]) -> dict[str, str]:
    """
    Derive parent links from the header change signatures of the files of one document variant.

    Args:
        signatures: Change signatures by stable_id

    Returns:
        Parent stable_id by child stable_id, for children with a unique parent
    """
    parents: dict[str, str] = {}
    for child, child_sigs in signatures.items():
        best: Optional[str] = None
        best_length = 0
        ambiguous = False
        for candidate, candidate_sigs in signatures.items():
            length = len(candidate_sigs)
            if candidate == child or not length or length >= len(child_sigs):
                continue
            if child_sigs[:length] != candidate_sigs:
                continue
            if length > best_length:
                best, best_length, ambiguous = candidate, length, False
            elif length == best_length:
                ambiguous = True
        if best and not ambiguous:
            parents[child] = best
    return parents


class Migration010AddParentStableIdColumn(Migration):
    """Add parent_stable_id column to files table and populate it from the revision history."""

    @property
    def version(self) -> int:
        return 10

    @property
    def description(self) -> str:
        return "Add parent_stable_id column to files table and derive it from the revision history"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        cursor = conn.execute("PRAGMA table_info(files)")
        columns = {row[1] for row in cursor.fetchall()}
        if "parent_stable_id" in columns:
            self.logger.info("Migration already applied (parent_stable_id column exists)")
            return False
        if "id" not in columns:
            self.logger.info("Files table does not exist yet, skipping migration")
            return False
        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        self.logger.info("Adding parent_stable_id column to files table")
        conn.execute("ALTER TABLE files ADD COLUMN parent_stable_id TEXT")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_parent_stable_id ON files(parent_stable_id)")
        self._populate(conn)

    def _populate(self, conn: sqlite3.Connection) -> None:
        from fastapi_app.lib.core.migrations.utils import get_file_storage_paths
        from fastapi_app.lib.utils.hash_utils import get_storage_path
        from fastapi_app.lib.utils.tei_utils import extract_change_signatures

        _, files_dir = get_file_storage_paths(conn)
        if not files_dir or not files_dir.exists():
            self.logger.debug(f"Files directory not found: {files_dir}, skipping data population")
            return

        rows = conn.execute(
            "SELECT id, stable_id, doc_id, variant FROM files WHERE file_type = 'tei' AND deleted = 0"
        ).fetchall()
        groups: dict[tuple[str, str], dict[str, list[Signature]]] = defaultdict(dict)
        for file_id, stable_id, doc_id, variant in rows:
            path = get_storage_path(files_dir, file_id, "tei")
            if not path.exists():
                continue
            groups[(doc_id, variant or "")][stable_id] = extract_change_signatures(path.read_bytes())

        count = 0
        for signatures in groups.values():
            for child, parent in find_parents(signatures).items():
                conn.execute("UPDATE files SET parent_stable_id = ? WHERE stable_id = ?", (parent, child))
                count += 1
        self.logger.info(f"Derived parent versions for {count} file(s)")

    def downgrade(self, conn: sqlite3.Connection) -> None:
        self.logger.info("Removing parent_stable_id column from files table")
        conn.execute("DROP INDEX IF EXISTS idx_parent_stable_id")
        conn.execute("ALTER TABLE files DROP COLUMN parent_stable_id")
