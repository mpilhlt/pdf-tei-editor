"""
Unit tests for migration 011 (whole-file human overrides become section overrides).

@testCovers fastapi_app/lib/core/migrations/versions/m011_document_rules_section_overrides.py
"""

import logging
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.core.migrations.versions.m009_document_rules_tables import (
    Migration009DocumentRulesTables,
)
from fastapi_app.lib.core.migrations.versions.m011_document_rules_section_overrides import (
    Migration011DocumentRulesSectionOverrides,
)

WHOLE = "# T\n## A\na1\n## B\nb1"


class TestMigration011(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.logger = logging.getLogger("test_migration_011")
        self.logger.setLevel(logging.ERROR)
        self.conn = sqlite3.connect(str(Path(self.temp_dir) / "test.db"))
        Migration009DocumentRulesTables(self.logger).upgrade(self.conn)
        self._insert("heading", "https://x/g.md#b", WHOLE)
        self._insert("lines", "https://x/g.md#L1-L2", WHOLE)
        self._insert("missing", "https://x/g.md#missing", "intro\n## A\na1\n## B\nb1")
        self._insert("plain", "https://x/g.md", WHOLE)
        self.conn.execute(
            "INSERT INTO resource_selection (owner, kind, resource_key, override_id) "
            "VALUES ('alice', 'interpretation-ref', 'https://x/g.md#missing', 'missing')"
        )
        self.conn.commit()
        self.migration = Migration011DocumentRulesSectionOverrides(self.logger)

    def tearDown(self):
        import shutil
        self.conn.close()
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def _insert(self, override_id: str, key: str, text: str) -> None:
        self.conn.execute(
            """INSERT INTO resource_overrides
               (id, kind, resource_key, owner, note, text, format, base_url, base_hash, created_at, updated_at)
               VALUES (?, 'interpretation-ref', ?, 'alice', '', ?, 'markdown', 'https://x', 'oldhash', 't', 't')""",
            (override_id, key, text),
        )

    def _row(self, override_id: str):
        return self.conn.execute(
            "SELECT text, base_hash FROM resource_overrides WHERE id = ?", (override_id,)
        ).fetchone()

    def test_heading_override_is_cut_to_its_section(self):
        self.migration.upgrade(self.conn)
        self.assertEqual(self._row("heading"), ("## B\nb1", ""))

    def test_other_rows_untouched(self):
        self.migration.upgrade(self.conn)
        self.assertEqual(self._row("lines"), (WHOLE, "oldhash"))
        self.assertEqual(self._row("plain"), (WHOLE, "oldhash"))

    def test_missing_anchor_row_and_selection_deleted(self):
        self.migration.upgrade(self.conn)
        self.assertIsNone(self._row("missing"))
        self.assertEqual(self.conn.execute("SELECT * FROM resource_selection").fetchall(), [])

    def test_idempotent(self):
        self.migration.upgrade(self.conn)
        before = self.conn.execute("SELECT * FROM resource_overrides ORDER BY id").fetchall()
        self.migration.upgrade(self.conn)
        after = self.conn.execute("SELECT * FROM resource_overrides ORDER BY id").fetchall()
        self.assertEqual(before, after)

    def test_other_kind_and_gitlab_line_range_untouched(self):
        self.conn.execute(
            """INSERT INTO resource_overrides
               (id, kind, resource_key, owner, note, text, format, base_url, base_hash, created_at, updated_at)
               VALUES ('schema', 'schema', 'https://x/g.md#b', 'alice', '', ?, 'markdown', 'https://x', 'oldhash', 't', 't')""",
            (WHOLE,),
        )
        self._insert("gitlab", "https://x/g.md#L1-2", WHOLE)
        self.migration.upgrade(self.conn)
        self.assertEqual(self._row("schema"), (WHOLE, "oldhash"))
        self.assertEqual(self._row("gitlab"), (WHOLE, "oldhash"))

    def test_runs_after_new_code_saved_sections(self):
        """Skipped-then-run sequence: new-format section rows must survive unchanged."""
        conn = sqlite3.connect(str(Path(self.temp_dir) / "fresh.db"))
        self.addCleanup(conn.close)
        migration = Migration011DocumentRulesSectionOverrides(self.logger)
        self.assertTrue(migration.check_can_apply(conn))
        migration.upgrade(conn)  # no table yet: no-op
        Migration009DocumentRulesTables(self.logger).upgrade(conn)
        for override_id, key, text in (
            ("sec", "https://x/g.md#b", "## B\nb1"),
            ("dup", "https://x/g.md#b-1", "## B\nb2"),
            ("renamed", "https://x/g.md#b", "## Renamed\nb1"),
        ):
            conn.execute(
                """INSERT INTO resource_overrides
                   (id, kind, resource_key, owner, note, text, format, base_url, base_hash, created_at, updated_at)
                   VALUES (?, 'interpretation-ref', ?, 'alice', '', ?, 'markdown', 'https://x', 'newhash', 't', 't')""",
                (override_id, key, text),
            )
        before = conn.execute("SELECT * FROM resource_overrides ORDER BY id").fetchall()
        migration.upgrade(conn)
        self.assertEqual(conn.execute("SELECT * FROM resource_overrides ORDER BY id").fetchall(), before)
