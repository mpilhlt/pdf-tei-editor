"""
Migration 011: Cut legacy whole-file human overrides down to their section

Before #645, a human-guide override (kind 'interpretation-ref') stored a full copy of the guide
file under a heading-anchor key (e.g. ".../guidelines.md#citation-model"). The same key now means
"the override of that heading section only". Existing rows are cut down to their section and get
an empty base_hash (no known base). Rows whose anchor is not found in their text are deleted
together with their selections. Line-range and fragment-less rows are untouched.

Before: heading-anchor override rows hold whole documents.
After: they hold only the section of the anchor, with base_hash = ''.
"""

import sqlite3

from fastapi_app.lib.core.migrations.base import Migration
from fastapi_app.lib.utils.annotation_rules_utils import (
    is_heading_anchor_fragment,
    markdown_section_range,
)


class Migration011DocumentRulesSectionOverrides(Migration):
    @property
    def version(self) -> int:
        return 11

    @property
    def description(self) -> str:
        return "Cut legacy whole-file human guide overrides down to their heading section"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resource_overrides'"
        )
        if cursor.fetchone() is None:
            self.logger.info("resource_overrides does not exist, skipping migration")
            return False
        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        rows = conn.execute(
            "SELECT id, resource_key, text FROM resource_overrides WHERE kind = 'interpretation-ref'"
        ).fetchall()
        cut = 0
        deleted = 0
        for override_id, resource_key, text in rows:
            fragment = resource_key.rpartition("#")[2] if "#" in resource_key else ""
            if not is_heading_anchor_fragment(fragment):
                continue
            section_range = markdown_section_range(text, fragment)
            if section_range is None:
                # Foreign keys are not enabled on the migration connection: no automatic cascade.
                conn.execute("DELETE FROM resource_selection WHERE override_id = ?", (override_id,))
                conn.execute("DELETE FROM resource_overrides WHERE id = ?", (override_id,))
                deleted += 1
                continue
            start, end = section_range
            section = "\n".join(text.splitlines()[start - 1:end])
            conn.execute(
                "UPDATE resource_overrides SET text = ?, base_hash = '' WHERE id = ?",
                (section, override_id),
            )
            cut += 1
        self.logger.info(f"Cut {cut} override(s) to their section, deleted {deleted} with missing anchor")

    def downgrade(self, conn: sqlite3.Connection) -> None:
        self.logger.info("Migration 011 cannot be reverted: the original whole files are not recoverable")
