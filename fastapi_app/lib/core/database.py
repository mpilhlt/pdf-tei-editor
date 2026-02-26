"""
Database manager for SQLite file metadata system.

Provides connection management, transactions, and thread-safe database access.
Uses context managers for proper resource cleanup.
"""

import sqlite3
import queue
from contextlib import contextmanager
from pathlib import Path
from typing import Optional, Generator
from fastapi_app.lib.core.db_schema import initialize_database
from . import sqlite_utils


class DatabaseManager:
    """
    Manages SQLite database connections and transactions.

    Thread-safe connection management with context managers for
    automatic resource cleanup and transaction handling.
    """

    def __init__(self, db_path: Path, logger=None):
        """
        Initialize database manager.

        Args:
            db_path: Path to SQLite database file
            logger: Optional logger instance
        """
        self.db_path = db_path
        self.logger = logger
        self._ensure_db_exists()
        self._pool = queue.Queue()

    def _ensure_db_exists(self) -> None:
        """
        Ensure database file and schema exist.

        Creates database file and initializes schema if needed.
        Runs any pending migrations automatically.
        This method is idempotent - safe to call multiple times.

        Uses a per-database lock to prevent concurrent schema initialization
        which can corrupt the database.
        """
        # Ensure parent directory exists
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        # Use per-database lock to prevent concurrent schema initialization
        with sqlite_utils.with_db_lock(self.db_path):
            # Use raw connection to avoid recursive locking from sqlite_utils.get_connection
            # and to ensure we have control over WAL mode setting
            conn = sqlite3.connect(str(self.db_path), timeout=60.0, isolation_level=None)
            try:
                # Enable WAL mode explicitly
                conn.execute("PRAGMA journal_mode = WAL")
                conn.execute("PRAGMA foreign_keys = ON")

                # Create database and initialize schema (including migrations)
                initialize_database(conn, self.logger, db_path=self.db_path)
            finally:
                conn.close()

    @contextmanager
    def get_connection(self) -> Generator[sqlite3.Connection, None, None]:
        """
        Context manager for database connections.

        Yields a connection with row_factory set to sqlite3.Row
        for dict-like access to query results.

        Usage:
            with db_manager.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM files")

        Yields:
            sqlite3.Connection: Database connection
        """
        try:
            conn = self._pool.get(block=False)
        except queue.Empty:
            conn = sqlite3.connect(str(self.db_path), timeout=60.0, check_same_thread=False, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")

        try:
            yield conn
        finally:
            # Rollback any uncommitted changes to ensure clean state for next use
            try:
                conn.rollback()
            except sqlite3.OperationalError:
                pass
            self._pool.put(conn)

    @contextmanager
    def transaction(self) -> Generator[sqlite3.Connection, None, None]:
        """
        Context manager for database transactions.

        Automatically commits on success, rolls back on exception.
        Useful for operations that require atomicity.

        Usage:
            with db_manager.transaction() as conn:
                cursor = conn.cursor()
                cursor.execute("INSERT INTO files ...")
                cursor.execute("UPDATE files ...")
                # Auto-commit on exit (or rollback on exception)

        Yields:
            sqlite3.Connection: Database connection with transaction
        """
        with self.get_connection() as conn:
            conn.execute("BEGIN")
            try:
                yield conn
                conn.commit()
                if self.logger:
                    self.logger.debug("Transaction committed")
            except Exception:
                try:
                    conn.rollback()
                except sqlite3.OperationalError:
                    pass
                raise

    def execute_query(
        self,
        query: str,
        params: tuple = (),
        fetch_one: bool = False
    ) -> Optional[list | dict]:
        """
        Execute a SELECT query and return results.

        Convenience method for simple queries.

        Args:
            query: SQL query string
            params: Query parameters
            fetch_one: If True, return single row; if False, return all rows

        Returns:
            Single row (dict) if fetch_one=True, list of rows otherwise
        """
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(query, params)

            if fetch_one:
                row = cursor.fetchone()
                return dict(row) if row else None
            else:
                rows = cursor.fetchall()
                return [dict(row) for row in rows]

    def execute_update(
        self,
        query: str,
        params: tuple = ()
    ) -> int:
        """
        Execute an INSERT, UPDATE, or DELETE query.

        Convenience method for simple updates.

        Args:
            query: SQL query string
            params: Query parameters

        Returns:
            Number of affected rows
        """
        with self.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute(query, params)
            return cursor.rowcount

    def clear_all_data(self) -> None:
        """
        Clear all data from the files table.

        This removes all file metadata records from the database.
        The table schema remains intact.

        Warning: This operation cannot be undone.
        """
        with self.transaction() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM files")
            deleted_count = cursor.rowcount

            if self.logger:
                self.logger.info(f"Cleared {deleted_count} records from database")
