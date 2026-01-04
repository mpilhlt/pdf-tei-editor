"""
Database manager for SQLite file metadata system.

Provides connection management, transactions, and thread-safe database access.
Uses context managers for proper resource cleanup.
"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Optional, Generator
from .db_schema import initialize_database


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

    def _ensure_db_exists(self) -> None:
        """
        Ensure database file and schema exist.

        Creates database file and initializes schema if needed.
        Runs any pending migrations automatically.
        This method is idempotent - safe to call multiple times.
        """
        # Ensure parent directory exists
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        # Create database and initialize schema (including migrations)
        with self.get_connection() as conn:
            initialize_database(conn, self.logger, db_path=self.db_path)

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
        conn = None
        try:
            conn = sqlite3.connect(
                str(self.db_path),
                # Enable foreign keys
                isolation_level=None  # autocommit mode by default
            )
            # Enable row factory for dict-like access
            conn.row_factory = sqlite3.Row

            # Set pragmas for better performance
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA journal_mode = WAL")  # Write-Ahead Logging

            yield conn
        except sqlite3.Error as e:
            if self.logger:
                self.logger.error(f"Database connection error: {e}")
            raise
        finally:
            if conn:
                conn.close()

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
        conn = None
        try:
            conn = sqlite3.connect(str(self.db_path))
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")

            # Begin transaction
            conn.execute("BEGIN")

            yield conn

            # Commit transaction
            conn.commit()

            if self.logger:
                self.logger.debug("Transaction committed")

        except sqlite3.Error as e:
            if conn:
                conn.rollback()
                if self.logger:
                    self.logger.error(f"Transaction rolled back: {e}")
            raise
        except Exception as e:
            if conn:
                conn.rollback()
                if self.logger:
                    self.logger.error(f"Transaction rolled back due to error: {e}")
            raise
        finally:
            if conn:
                conn.close()

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
