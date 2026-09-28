"""
Migration 009: Add document-rules override/selection tables

Adds the generic, resource-kind-agnostic storage for the document rules
registry (see
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md):
user-owned editable copies of a document-referenced resource
(resource_overrides) and each user's current selection per resource
(resource_selection). Neither table references "prompt" or "schema" by
name, so a future resource kind needs no schema change.

Before: neither table exists.
After: resource_overrides and resource_selection exist, with
resource_selection.override_id cascading on delete.
"""

import sqlite3

from fastapi_app.lib.core.migrations.base import Migration


class Migration009DocumentRulesTables(Migration):
    @property
    def version(self) -> int:
        return 9

    @property
    def description(self) -> str:
        return "Add resource_overrides and resource_selection tables for the document rules registry"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        cursor = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resource_overrides'"
        )
        if cursor.fetchone() is not None:
            self.logger.info("Migration already applied (resource_overrides exists)")
            return False
        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        self.logger.info("Creating resource_overrides and resource_selection tables")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS resource_overrides (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                resource_key TEXT NOT NULL,
                owner TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                text TEXT NOT NULL,
                format TEXT NOT NULL,
                base_url TEXT NOT NULL,
                base_hash TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_resource_overrides_owner_key "
            "ON resource_overrides (owner, kind, resource_key)"
        )
        conn.execute("""
            CREATE TABLE IF NOT EXISTS resource_selection (
                owner TEXT NOT NULL,
                kind TEXT NOT NULL,
                resource_key TEXT NOT NULL,
                override_id TEXT NOT NULL REFERENCES resource_overrides (id) ON DELETE CASCADE,
                PRIMARY KEY (owner, kind, resource_key)
            )
        """)
        self.logger.info("Migration 009 complete")

    def downgrade(self, conn: sqlite3.Connection) -> None:
        self.logger.info("Reverting migration 009")
        conn.execute("DROP TABLE IF EXISTS resource_selection")
        conn.execute("DROP TABLE IF EXISTS resource_overrides")
