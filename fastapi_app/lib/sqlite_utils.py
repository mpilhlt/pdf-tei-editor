"""
Centralized SQLite connection utilities.

Provides thread-safe connection management with WAL mode initialization
and retry logic for concurrent access scenarios.

All SQLite database code should use these utilities instead of raw sqlite3.connect().
"""

import sqlite3
import time
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Generator
import logging

logger = logging.getLogger(__name__)

# Track which databases have been initialized with WAL mode
_initialized_databases: set[str] = set()

# Global lock for managing _initialized_databases set
_init_lock = threading.Lock()

# Per-database locks for schema initialization (prevents concurrent schema creation)
_db_locks: dict[str, threading.RLock] = {}  # RLock allows same thread to acquire multiple times
_db_locks_lock = threading.Lock()  # Lock for accessing _db_locks dict

# Default retry configuration
DEFAULT_RETRY_COUNT = 5
DEFAULT_RETRY_DELAY = 0.05  # seconds


def _get_db_lock(db_path: Path) -> threading.RLock:
    """
    Get or create a reentrant lock for a specific database.

    Uses RLock to allow the same thread to acquire the lock multiple times,
    which prevents deadlocks when nested calls need the same lock.

    Args:
        db_path: Path to the SQLite database file

    Returns:
        RLock for this database
    """
    db_key = str(db_path.resolve())
    with _db_locks_lock:
        if db_key not in _db_locks:
            _db_locks[db_key] = threading.RLock()
        return _db_locks[db_key]


def _ensure_wal_mode(db_path: Path) -> None:
    """
    Ensure WAL mode is enabled for a database.

    This is called once per database path during application lifetime.
    Uses a reentrant lock to allow nested calls from the same thread.

    Args:
        db_path: Path to the SQLite database file
    """
    db_key = str(db_path.resolve())

    # Quick check without lock
    with _init_lock:
        if db_key in _initialized_databases:
            return

    # Use per-database reentrant lock
    db_lock = _get_db_lock(db_path)
    with db_lock:
        # Double-check after acquiring lock
        with _init_lock:
            if db_key in _initialized_databases:
                return

        # Ensure parent directory exists
        db_path.parent.mkdir(parents=True, exist_ok=True)

        # Use a dedicated connection to set WAL mode
        for attempt in range(DEFAULT_RETRY_COUNT):
            try:
                conn = sqlite3.connect(str(db_path), timeout=30.0)
                try:
                    conn.execute("PRAGMA journal_mode = WAL")
                    with _init_lock:
                        _initialized_databases.add(db_key)
                    logger.debug(f"WAL mode enabled for {db_path.name}")
                    return
                finally:
                    conn.close()
            except sqlite3.OperationalError as e:
                if attempt < DEFAULT_RETRY_COUNT - 1:
                    logger.warning(
                        f"Failed to set WAL mode for {db_path.name} "
                        f"(attempt {attempt + 1}/{DEFAULT_RETRY_COUNT}): {e}"
                    )
                    time.sleep(DEFAULT_RETRY_DELAY * (attempt + 1))
                else:
                    logger.error(f"Failed to set WAL mode for {db_path.name} after {DEFAULT_RETRY_COUNT} attempts")
                    raise


@contextmanager
def with_db_lock(db_path: Path):
    """
    Context manager that acquires a reentrant lock for a database.

    Use this to protect database initialization or other operations
    that must not run concurrently for the same database.

    Uses RLock so the same thread can acquire the lock multiple times
    (e.g., when _ensure_db_exists calls get_connection which calls _ensure_wal_mode).

    Args:
        db_path: Path to the SQLite database file

    Yields:
        None (lock is held while in context)
    """
    db_lock = _get_db_lock(db_path)
    with db_lock:
        yield


@contextmanager
def get_connection(
    db_path: Path,
    timeout: float = 30.0,
    row_factory: bool = True,
    foreign_keys: bool = True,
    retry_count: int = DEFAULT_RETRY_COUNT,
    retry_delay: float = DEFAULT_RETRY_DELAY
) -> Generator[sqlite3.Connection, None, None]:
    """
    Get a database connection with proper configuration.

    Ensures WAL mode is enabled (once per database) and provides
    retry logic for transient connection failures.

    Args:
        db_path: Path to the SQLite database file
        timeout: Connection timeout in seconds
        row_factory: If True, use sqlite3.Row for dict-like access
        foreign_keys: If True, enable foreign key constraints
        retry_count: Number of connection retry attempts
        retry_delay: Base delay between retries (multiplied by attempt number)

    Yields:
        sqlite3.Connection: Configured database connection

    Raises:
        sqlite3.Error: If connection fails after all retries
    """
    # Ensure WAL mode is set (no-op if already done)
    _ensure_wal_mode(db_path)

    conn = None
    last_error = None

    for attempt in range(retry_count):
        try:
            conn = sqlite3.connect(
                str(db_path),
                timeout=timeout,
                isolation_level=None,  # autocommit mode
                check_same_thread=False
            )

            if row_factory:
                conn.row_factory = sqlite3.Row

            if foreign_keys:
                conn.execute("PRAGMA foreign_keys = ON")

            yield conn
            return

        except sqlite3.OperationalError as e:
            last_error = e
            if conn:
                try:
                    conn.close()
                except Exception:
                    pass
                conn = None

            if attempt < retry_count - 1:
                delay = retry_delay * (attempt + 1)
                logger.warning(
                    f"Database connection failed for {db_path.name} "
                    f"(attempt {attempt + 1}/{retry_count}): {e}. "
                    f"Retrying in {delay:.2f}s..."
                )
                time.sleep(delay)
            else:
                logger.error(
                    f"Database connection failed for {db_path.name} "
                    f"after {retry_count} attempts: {e}"
                )
        finally:
            if conn:
                conn.close()

    # If we get here, all retries failed
    raise last_error or sqlite3.OperationalError("Connection failed")


@contextmanager
def transaction(
    db_path: Path,
    timeout: float = 30.0,
    row_factory: bool = True,
    foreign_keys: bool = True
) -> Generator[sqlite3.Connection, None, None]:
    """
    Get a database connection with transaction semantics.

    Automatically commits on success, rolls back on exception.

    Args:
        db_path: Path to the SQLite database file
        timeout: Connection timeout in seconds
        row_factory: If True, use sqlite3.Row for dict-like access
        foreign_keys: If True, enable foreign key constraints

    Yields:
        sqlite3.Connection: Database connection with active transaction

    Raises:
        sqlite3.Error: If transaction fails
    """
    _ensure_wal_mode(db_path)

    conn = None
    try:
        conn = sqlite3.connect(str(db_path), timeout=timeout)

        if row_factory:
            conn.row_factory = sqlite3.Row

        if foreign_keys:
            conn.execute("PRAGMA foreign_keys = ON")

        conn.execute("BEGIN")
        yield conn
        conn.commit()

    except Exception:
        if conn:
            conn.rollback()
        raise
    finally:
        if conn:
            conn.close()


def reset_initialized_databases() -> None:
    """
    Reset the set of initialized databases.

    This is primarily for testing purposes, to allow re-initialization
    of WAL mode after database files are deleted/recreated.
    """
    with _init_lock:
        _initialized_databases.clear()
        logger.debug("Reset initialized databases tracking")
