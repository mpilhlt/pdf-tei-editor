"""
Migration 013: Add the launch_tokens table to the sessions database

Backend plugin windows open with a single-use launch token in the URL instead of the session id. The
server exchanges the token for a cookie (see ``fastapi_app/lib/plugins/plugin_window_auth.py``). The
table holds the SHA-256 hash of each token, the session it stands for, and its expiry.

Before: sessions.db has the sessions table
After: sessions.db also has launch_tokens(token_hash, session_id, expires_at)
"""

import sqlite3

from fastapi_app.lib.core.migrations.base import Migration


class Migration013SessionsLaunchTokens(Migration):
    """Create the ``launch_tokens`` table."""

    @property
    def version(self) -> int:
        return 13

    @property
    def description(self) -> str:
        return "Add the launch_tokens table for plugin window launch tokens"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        """False if the launch_tokens table already exists."""
        row = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='launch_tokens'").fetchone()
        if row is not None:
            self.logger.info("Migration already applied (launch_tokens table exists)")
            return False
        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        """Create the table."""
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS launch_tokens (
                token_hash TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                expires_at REAL NOT NULL
            )
            """
        )
        self.logger.info("Created the launch_tokens table")

    def downgrade(self, conn: sqlite3.Connection) -> None:
        """Drop the table."""
        conn.execute("DROP TABLE IF EXISTS launch_tokens")
