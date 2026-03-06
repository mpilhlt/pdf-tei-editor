"""
Session management for PDF-TEI-Editor.

This module provides SQLite-based session management with dependency injection.
No Flask or FastAPI dependencies - all parameters are explicitly passed.
"""

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


# SQLite schema for sessions table
SESSIONS_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at REAL NOT NULL,
    last_access REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_username ON sessions(username);
CREATE INDEX IF NOT EXISTS idx_last_access ON sessions(last_access);
"""


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
        """Initialize sessions database and table."""
        init_database(self.db_path, SESSIONS_SCHEMA, self.logger)

    def create_session(self, username: str) -> str:
        """
        Create new session for a user.

        Args:
            username: Username to create session for

        Returns:
            Generated UUID session ID
        """
        session_id = str(uuid.uuid4())
        current_time = time.time()

        conn = get_connection(self.db_path)
        conn.execute(
            """
            INSERT INTO sessions (session_id, username, created_at, last_access)
            VALUES (?, ?, ?, ?)
            """,
            (session_id, username, current_time, current_time)
        )
        conn.commit()

        if self.logger:
            self.logger.info(f"Created session {session_id} for user {username}")

        return session_id

    def get_session(self, session_id: str) -> Optional[dict]:
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
            """
            SELECT session_id, username, created_at, last_access
            FROM sessions
            WHERE session_id = ?
            """,
            (session_id,)
        )

        row = cursor.fetchone()
        if row:
            return {
                'session_id': row['session_id'],
                'username': row['username'],
                'created_at': row['created_at'],
                'last_access': row['last_access']
            }

        return None

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
                WHERE last_access < ?
                """,
                (expiry_time,)
            )
            expired_sessions = cursor.fetchall()

            for row in expired_sessions:
                self.logger.info(
                    f"Cleaning up expired session {row['session_id']} for user {row['username']}"
                )

        # Delete expired sessions
        cursor = conn.execute(
            "DELETE FROM sessions WHERE last_access < ?",
            (expiry_time,)
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
            List of session dictionaries with keys: session_id, username, created_at, last_access
        """
        conn = get_connection(self.db_path)
        cursor = conn.execute(
            """
            SELECT session_id, username, created_at, last_access
            FROM sessions
            ORDER BY last_access DESC
            """
        )

        return [
            {
                'session_id': row['session_id'],
                'username': row['username'],
                'created_at': row['created_at'],
                'last_access': row['last_access']
            }
            for row in cursor.fetchall()
        ]
