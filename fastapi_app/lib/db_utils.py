"""
Database utilities for PDF-TEI-Editor.

This module provides framework-agnostic SQLite database utilities.
Handles connection management, initialization, and transactions.
"""

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Optional


# Thread-local storage for database connections
_thread_local = threading.local()


def get_connection(db_path: Path) -> sqlite3.Connection:
    """
    Get a thread-local database connection.

    Each thread gets its own connection to avoid SQLite threading issues.
    Connections are cached per thread for efficiency.

    Args:
        db_path: Path to the SQLite database file

    Returns:
        SQLite connection for the current thread
    """
    # Check if this thread has a connection to this database
    if not hasattr(_thread_local, 'connections'):
        _thread_local.connections = {}

    db_key = str(db_path)

    if db_key not in _thread_local.connections:
        # Create parent directory if needed
        db_path.parent.mkdir(parents=True, exist_ok=True)

        # Create new connection for this thread
        conn = sqlite3.connect(str(db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row  # Enable row access by column name
        conn.execute('PRAGMA journal_mode=WAL')  # Write-Ahead Logging for better concurrency
        conn.execute('PRAGMA foreign_keys=ON')  # Enable foreign key constraints

        _thread_local.connections[db_key] = conn

    return _thread_local.connections[db_key]


@contextmanager
def transaction(db_path: Path):
    """
    Context manager for database transactions.

    Automatically commits on success, rolls back on exception.

    Args:
        db_path: Path to the SQLite database file

    Yields:
        SQLite connection with active transaction

    Example:
        with transaction(db_path) as conn:
            conn.execute("INSERT INTO ...")
            conn.execute("UPDATE ...")
        # Automatically committed here
    """
    conn = get_connection(db_path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def execute_query(db_path: Path, query: str, params: tuple = ()) -> list:
    """
    Execute a SELECT query and return all results.

    Args:
        db_path: Path to the SQLite database file
        query: SQL SELECT query
        params: Query parameters (tuple)

    Returns:
        List of rows (as sqlite3.Row objects)
    """
    conn = get_connection(db_path)
    cursor = conn.execute(query, params)
    return cursor.fetchall()


def execute_update(db_path: Path, query: str, params: tuple = ()) -> int:
    """
    Execute an INSERT/UPDATE/DELETE query.

    Args:
        db_path: Path to the SQLite database file
        query: SQL query
        params: Query parameters (tuple)

    Returns:
        Number of rows affected
    """
    conn = get_connection(db_path)
    cursor = conn.execute(query, params)
    conn.commit()
    return cursor.rowcount


def init_database(db_path: Path, schema: str, logger=None):
    """
    Initialize database with schema.

    Creates tables if they don't exist.

    Args:
        db_path: Path to the SQLite database file
        schema: SQL schema (CREATE TABLE statements)
        logger: Optional logger for logging operations
    """
    conn = get_connection(db_path)

    if logger:
        logger.debug(f"Initializing database at {db_path}")

    # Execute schema (CREATE TABLE IF NOT EXISTS statements)
    conn.executescript(schema)
    conn.commit()

    if logger:
        logger.debug("Database initialized successfully")


def close_connection(db_path: Path):
    """
    Close the thread-local connection for a database.

    Args:
        db_path: Path to the SQLite database file
    """
    if not hasattr(_thread_local, 'connections'):
        return

    db_key = str(db_path)

    if db_key in _thread_local.connections:
        _thread_local.connections[db_key].close()
        del _thread_local.connections[db_key]


def close_all_connections():
    """
    Close all thread-local database connections.

    Useful for cleanup or testing.
    """
    if not hasattr(_thread_local, 'connections'):
        return

    for conn in _thread_local.connections.values():
        conn.close()

    _thread_local.connections = {}
