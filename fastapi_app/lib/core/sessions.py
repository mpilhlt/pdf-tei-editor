"""
Session management for PDF-TEI-Editor.

This module provides SQLite-based session management with dependency injection.
No Flask or FastAPI dependencies - all parameters are explicitly passed.
"""

import sqlite3
import time
import uuid
from pathlib import Path
from typing import Optional, TypedDict

from fastapi_app.lib.core.db_utils import get_connection, init_database


class SessionDict(TypedDict):
    """Type definition for session dictionary."""
    session_id: str
    username: str
    created_at: float
    last_access: float
    token_id: Optional[str]
    """The personal access token the session was created from (None for a password login)"""
    expires_at: Optional[float]
    """Absolute expiry (the token's expiry); None if the session only expires through inactivity"""


# SQLite schema for sessions table
SESSIONS_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at REAL NOT NULL,
    last_access REAL NOT NULL,
    token_id TEXT,
    expires_at REAL
);

CREATE INDEX IF NOT EXISTS idx_username ON sessions(username);
CREATE INDEX IF NOT EXISTS idx_last_access ON sessions(last_access);
"""

_SESSION_COLUMNS = "session_id, username, created_at, last_access, token_id, expires_at"


def _row_to_session(row: sqlite3.Row) -> SessionDict:
    """Convert a sessions row into a SessionDict."""
    return {
        'session_id': row['session_id'],
        'username': row['username'],
        'created_at': row['created_at'],
        'last_access': row['last_access'],
        'token_id': row['token_id'],
        'expires_at': row['expires_at'],
    }


class SessionManager:
    """
    SQLite-based session manager with dependency injection.

    Manages user sessions with expiration tracking using SQLite for
    thread-safe concurrent access and better performance.
    """

    def __init__(self, db_dir: Path, logger=None):
        """
        Initialize session manager with SQLite backend.

        Args:
            db_dir: Path to the database directory
            logger: Optional logger instance for logging operations
        """
        self.db_dir = db_dir
        self.logger = logger
        self.db_path = db_dir / 'sessions.db'
        self._init_db()

    def _init_db(self):
        """Initialize sessions database and table, and run the sessions migrations."""
        from fastapi_app.lib.core.migration_runner import run_migrations_if_needed
        from fastapi_app.lib.core.migrations.versions import SESSIONS_MIGRATIONS

        init_database(self.db_path, SESSIONS_SCHEMA, self.logger)
        run_migrations_if_needed(db_path=self.db_path, migrations=SESSIONS_MIGRATIONS, logger=self.logger)
        # Needs the token_id column, which databases created before migration 012 only have afterwards
        init_database(self.db_path, "CREATE INDEX IF NOT EXISTS idx_token_id ON sessions(token_id);", self.logger)

    def create_session(
        self,
        username: str,
        token_id: Optional[str] = None,
        expires_at: Optional[float] = None,
    ) -> str:
        """
        Create new session for a user.

        Args:
            username: Username to create session for
            token_id: The personal access token the session is created from, if any
            expires_at: Absolute expiry of the session (epoch seconds), e.g. the token's expiry

        Returns:
            Generated UUID session ID
        """
        session_id = str(uuid.uuid4())
        current_time = time.time()

        conn = get_connection(self.db_path)
        conn.execute(
            """
            INSERT INTO sessions (session_id, username, created_at, last_access, token_id, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (session_id, username, current_time, current_time, token_id, expires_at)
        )
        conn.commit()

        if self.logger:
            self.logger.info(f"Created session {session_id} for user {username}")

        return session_id

    def get_session(self, session_id: str) -> Optional[SessionDict]:
        """
        Get session data by session ID.

        Args:
            session_id: Session ID to look up

        Returns:
            Session data dictionary or None if not found
        """
        if not session_id:
            return None

        conn = get_connection(self.db_path)
        cursor = conn.execute(
            f"SELECT {_SESSION_COLUMNS} FROM sessions WHERE session_id = ?",
            (session_id,)
        )

        row = cursor.fetchone()
        return _row_to_session(row) if row else None

    def get_username_by_session_id(self, session_id: str) -> Optional[str]:
        """
        Get username associated with a session ID.

        Args:
            session_id: Session ID to look up

        Returns:
            Username or None if session not found
        """
        session = self.get_session(session_id)
        return session['username'] if session else None

    def is_session_valid(self, session_id: str, timeout_seconds: int) -> bool:
        """
        Check if a session exists and hasn't expired.

        Args:
            session_id: Session ID to check
            timeout_seconds: Session timeout in seconds

        Returns:
            True if session is valid, False otherwise
        """
        session = self.get_session(session_id)
        if not session:
            return False

        current_time = time.time()
        if session['expires_at'] is not None and current_time >= session['expires_at']:
            return False
        last_access = session['last_access']
        return current_time - last_access <= timeout_seconds

    def update_session_access_time(self, session_id: str) -> bool:
        """
        Update last access time for a session.

        Args:
            session_id: Session ID to update

        Returns:
            True if updated, False if session not found
        """
        if not session_id:
            return False

        current_time = time.time()

        conn = get_connection(self.db_path)
        cursor = conn.execute(
            """
            UPDATE sessions
            SET last_access = ?
            WHERE session_id = ?
            """,
            (current_time, session_id)
        )
        conn.commit()

        return cursor.rowcount > 0

    def delete_session(self, session_id: str) -> bool:
        """
        Delete a session.

        Args:
            session_id: Session ID to delete

        Returns:
            True if deleted, False if session not found
        """
        if not session_id:
            return False

        # Get username before deletion for logging
        session = self.get_session(session_id)
        if not session:
            return False

        username = session['username']

        conn = get_connection(self.db_path)
        cursor = conn.execute(
            "DELETE FROM sessions WHERE session_id = ?",
            (session_id,)
        )
        conn.commit()

        if cursor.rowcount > 0:
            if self.logger:
                self.logger.info(f"Deleted session {session_id} for user {username}")
            return True

        return False

    def delete_all_user_sessions(self, username: str) -> int:
        """
        Delete all sessions for a specific user.

        Args:
            username: Username whose sessions to delete

        Returns:
            Number of sessions deleted
        """
        conn = get_connection(self.db_path)
        cursor = conn.execute(
            "DELETE FROM sessions WHERE username = ?",
            (username,)
        )
        conn.commit()

        count = cursor.rowcount

        if count > 0 and self.logger:
            self.logger.info(f"Deleted {count} sessions for user {username}")

        return count

    def delete_token_sessions(self, token_id: str) -> int:
        """
        Delete all sessions created from a personal access token.

        Args:
            token_id: Public id of the token

        Returns:
            Number of sessions deleted
        """
        conn = get_connection(self.db_path)
        cursor = conn.execute("DELETE FROM sessions WHERE token_id = ?", (token_id,))
        conn.commit()

        count = cursor.rowcount
        if count > 0 and self.logger:
            self.logger.info(f"Deleted {count} sessions of access token {token_id}")
        return count

    def cleanup_expired_sessions(self, timeout_seconds: int) -> int:
        """
        Remove sessions that haven't been accessed within the timeout period.

        Args:
            timeout_seconds: Session timeout in seconds

        Returns:
            Number of sessions cleaned up
        """
        current_time = time.time()
        expiry_time = current_time - timeout_seconds

        conn = get_connection(self.db_path)

        # Get expired sessions for logging
        if self.logger:
            cursor = conn.execute(
                """
                SELECT session_id, username
                FROM sessions
                WHERE last_access < ? OR (expires_at IS NOT NULL AND expires_at <= ?)
                """,
                (expiry_time, current_time)
            )
            expired_sessions = cursor.fetchall()

            for row in expired_sessions:
                self.logger.info(
                    f"Cleaning up expired session {row['session_id']} for user {row['username']}"
                )

        # Delete expired sessions
        cursor = conn.execute(
            "DELETE FROM sessions WHERE last_access < ? OR (expires_at IS NOT NULL AND expires_at <= ?)",
            (expiry_time, current_time)
        )
        conn.commit()

        return cursor.rowcount

    def get_user_session_count(self, username: str) -> int:
        """
        Get the number of active sessions for a user.

        Args:
            username: Username to count sessions for

        Returns:
            Number of active sessions
        """
        conn = get_connection(self.db_path)
        cursor = conn.execute(
            "SELECT COUNT(*) as count FROM sessions WHERE username = ?",
            (username,)
        )

        row = cursor.fetchone()
        return row['count'] if row else 0

    def get_all_sessions(self) -> list[SessionDict]:
        """
        Get all active sessions.

        Returns:
            List of session dictionaries (see SessionDict)
        """
        conn = get_connection(self.db_path)
        cursor = conn.execute(f"SELECT {_SESSION_COLUMNS} FROM sessions ORDER BY last_access DESC")
        return [_row_to_session(row) for row in cursor.fetchall()]
