"""
Migration 012: Add token_id and expires_at columns to the sessions table

Sessions created by exchanging a personal access token (``POST /api/v1/auth/token-login``) record the
token they were created from, so that revoking the token also ends its sessions, and the token's expiry,
so that such a session does not outlive the token.

Before: sessions(session_id, username, created_at, last_access)
After: sessions(session_id, username, created_at, last_access, token_id, expires_at)
"""

import sqlite3

from fastapi_app.lib.core.migrations.base import Migration


class Migration012SessionsTokenColumns(Migration):
    """Add the nullable ``token_id`` and ``expires_at`` columns to the sessions table."""

    @property
    def version(self) -> int:
        return 12

    @property
    def description(self) -> str:
        return "Add token_id and expires_at columns to the sessions table"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        """False if the sessions table does not exist or already has the columns."""
        columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()}
        if "session_id" not in columns:
            self.logger.info("Sessions table does not exist yet, skipping migration")
            return False
        if "token_id" in columns and "expires_at" in columns:
            self.logger.info("Migration already applied (token_id and expires_at columns exist)")
            return False
        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        """Add the columns that are missing and an index on token_id."""
        columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()}
        if "token_id" not in columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN token_id TEXT")
        if "expires_at" not in columns:
            conn.execute("ALTER TABLE sessions ADD COLUMN expires_at REAL")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_token_id ON sessions(token_id)")
        self.logger.info("Added token_id and expires_at columns to the sessions table")

    def downgrade(self, conn: sqlite3.Connection) -> None:
        """Drop the index and the columns (SQLite 3.35+)."""
        conn.execute("DROP INDEX IF EXISTS idx_token_id")
        conn.execute("ALTER TABLE sessions DROP COLUMN expires_at")
        conn.execute("ALTER TABLE sessions DROP COLUMN token_id")
