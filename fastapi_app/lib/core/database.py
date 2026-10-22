"""
Database manager for SQLite file metadata system.

Provides connection management, transactions, and thread-safe database access.
Uses context managers for proper resource cleanup.
"""

import gc
import logging
import shutil
import sqlite3
import queue
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Optional, Generator
from fastapi_app.lib.core.db_schema import initialize_database
from . import sqlite_utils

_logger = logging.getLogger(__name__)

# Primary result codes after which a connection must not be reused (see is_connection_broken)
_BROKEN_CONNECTION_CODES = {sqlite3.SQLITE_IOERR, sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB}


def is_connection_broken(error: BaseException) -> bool:
    """
    Check whether an error means that the connections to a database must be reopened.

    SQLite reports "disk I/O error" (SQLITE_IOERR) when the database file or its
    -wal/-shm files were removed or replaced while connections were open. The
    process keeps the stale WAL index mapped as long as any of its connections to
    the database is open, so all connections fail, including new ones. Closing every
    connection of the process lets SQLite map fresh files again.

    Args:
        error: Exception raised while using a connection

    Returns:
        True if the error is an SQLite I/O or corruption error
    """
    if not isinstance(error, sqlite3.DatabaseError):
        return False
    code = getattr(error, "sqlite_errorcode", None)
    if code is not None:
        return (code & 0xFF) in _BROKEN_CONNECTION_CODES
    message = str(error)
    return "disk I/O error" in message or "malformed" in message


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
        # Idle connections as (generation, connection); connections of an older
        # generation are closed instead of being reused (see _discard_connections)
        self._pool: queue.Queue[tuple[int, sqlite3.Connection]] = queue.Queue()
        self._generation = 0
        self._generation_lock = threading.Lock()
        self._collect_pending = False

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

        Connections are pooled. If an SQLite I/O or corruption error occurs while the
        connection is in use, this connection and all pooled ones are closed, so the
        next request opens fresh connections instead of failing until a restart.

        Usage:
            with db_manager.get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM files")

        Yields:
            sqlite3.Connection: Database connection
        """
        generation, conn = self._acquire_connection()
        broken = False
        try:
            yield conn
        except Exception as e:
            if is_connection_broken(e):
                broken = True
                self._discard_connections(e)
            raise
        finally:
            self._release_connection(generation, conn, broken)

    def _acquire_connection(self) -> tuple[int, sqlite3.Connection]:
        """
        Take an idle connection from the pool or open a new one.

        Returns:
            Tuple of the pool generation and the connection
        """
        if self._collect_pending:
            # A failed request leaves its connection, cursor and exception in a reference
            # cycle. Until the cycle is collected, the closed connection stays open in
            # SQLite (its statements are not finalized) and keeps the stale WAL index.
            self._collect_pending = False
            gc.collect()

        while True:
            try:
                generation, conn = self._pool.get(block=False)
            except queue.Empty:
                break
            if generation == self._generation:
                return generation, conn
            self._close_quietly(conn)

        generation = self._generation
        try:
            conn = sqlite3.connect(str(self.db_path), timeout=60.0, check_same_thread=False, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys = ON")
        except sqlite3.Error as e:
            if is_connection_broken(e):
                self._discard_connections(e)
            raise
        return generation, conn

    def _release_connection(self, generation: int, conn: sqlite3.Connection, broken: bool) -> None:
        """
        Return a connection to the pool, or close it if it is broken or outdated.

        Args:
            generation: Pool generation the connection was acquired in
            conn: The connection
            broken: True if an SQLite I/O or corruption error occurred on it
        """
        if broken or generation != self._generation:
            self._close_quietly(conn)
            return
        # Rollback any uncommitted changes to ensure clean state for next use
        try:
            conn.rollback()
        except sqlite3.Error as e:
            if is_connection_broken(e):
                self._discard_connections(e)
            self._close_quietly(conn)
            return
        self._pool.put((generation, conn))

    def _discard_connections(self, error: BaseException) -> None:
        """
        Close all idle pooled connections and retire the connections in use.

        Connections in use are closed when they are released. Logs the state of the
        database files to help finding out what invalidated them.

        Args:
            error: The SQLite error that triggered the reset
        """
        with self._generation_lock:
            self._generation += 1
        self._collect_pending = True
        closed = 0
        while True:
            try:
                _, conn = self._pool.get(block=False)
            except queue.Empty:
                break
            self._close_quietly(conn)
            closed += 1
        (self.logger or _logger).warning(
            f"SQLite error on {self.db_path.name}: {error}. Closed {closed} pooled connection(s), new connections will be opened. {self._describe_files()}"
        )

    def _describe_files(self) -> str:
        """
        Describe the database files and free disk space for diagnostic logging.

        Returns:
            Human-readable summary of the database file state
        """
        parts = []
        for suffix in ("", "-wal", "-shm"):
            path = Path(f"{self.db_path}{suffix}")
            try:
                stat = path.stat()
                parts.append(f"{path.name}: {stat.st_size} bytes, inode {stat.st_ino}")
            except OSError:
                parts.append(f"{path.name}: missing")
        try:
            usage = shutil.disk_usage(self.db_path.parent)
            parts.append(f"free disk space: {usage.free // (1024 * 1024)} MiB")
        except OSError as e:
            parts.append(f"disk usage unavailable: {e}")
        return "; ".join(parts)

    @staticmethod
    def _close_quietly(conn: sqlite3.Connection) -> None:
        """Close a connection, ignoring errors."""
        try:
            conn.close()
        except sqlite3.Error:
            pass

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
