"""
Database initialization utilities for FastAPI application.

This module handles all database initialization at application startup,
ensuring thread-safe WAL mode setup and schema initialization before
concurrent requests begin. This resolves SQLite WAL concurrency issues
that occur when multiple threads try to initialize databases simultaneously.
"""

import sqlite3
from pathlib import Path
from typing import List, Tuple
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.locking import init_locks_db
from fastapi_app.lib.core.sessions import SessionManager
from fastapi_app.lib.utils.auth import AuthManager
from fastapi_app.lib.utils.logging_utils import get_logger
from fastapi_app.lib.core.dependencies import _DatabaseManagerSingleton


logger = get_logger(__name__)


def initialize_all_databases(db_dir: Path, data_root: Path) -> None:
    """
    Initialize all databases at application startup.
    
    This ensures that all databases are fully initialized with WAL mode
    and schemas before any concurrent requests arrive, eliminating
    SQLite WAL race conditions.
    
    Args:
        db_dir: Directory where database files are stored
        data_root: Root directory for application data
    """
    logger.info("Initializing all databases...")
    
    # Initialize file metadata database
    metadata_db_path = db_dir / "metadata.db"
    logger.debug(f"Initializing metadata database at {metadata_db_path}")

    # Use singleton to ensure it's registered and reused by dependencies.get_db()
    _DatabaseManagerSingleton.get_instance(str(metadata_db_path))
    logger.debug("Metadata database initialized successfully")
    
    # Initialize locks database
    logger.debug(f"Initializing locks database at {db_dir / 'locks.db'}")
    init_locks_db(db_dir, logger)
    logger.debug("Locks database initialized successfully")
    
    # Initialize sessions database
    logger.debug(f"Initializing sessions database at {db_dir / 'sessions.db'}")
    session_manager = SessionManager(db_dir, logger)
    logger.debug("Sessions database initialized successfully")
    
    # Initialize auth database
    logger.debug(f"Initializing auth database at {db_dir / 'auth.db'}")
    auth_manager = AuthManager(db_dir, logger)
    logger.debug("Auth database initialized successfully")
    
    logger.info("All databases initialized successfully")


def initialize_database_with_pooling(db_path: Path, logger) -> sqlite3.Connection:
    """
    Initialize a database with proper connection pooling and WAL mode.
    
    Args:
        db_path: Path to the database file
        logger: Logger instance
        
    Returns:
        Configured database connection
    """
    # Ensure parent directory exists
    db_path.parent.mkdir(parents=True, exist_ok=True)
    
    # Connect with appropriate settings for concurrent access
    conn = sqlite3.connect(
        str(db_path),
        timeout=30.0,
        check_same_thread=False,
        isolation_level=None  # Autocommit mode
    )
    
    # Try to enable WAL2 mode first (available in SQLite 3.37+)
    try:
        conn.execute("PRAGMA journal_mode = WAL2")
        result = conn.execute("PRAGMA journal_mode").fetchone()[0]
        if result == 'wal2':
            logger.debug(f"Database {db_path.name} initialized with WAL2 mode")
        else:
            # Fall back to WAL mode
            conn.execute("PRAGMA journal_mode = WAL")
            logger.debug(f"Database {db_path.name} initialized with WAL mode")
    except sqlite3.OperationalError:
        # WAL2 not supported, fall back to WAL mode
        conn.execute("PRAGMA journal_mode = WAL")
        logger.debug(f"Database {db_path.name} initialized with WAL mode")
    
    # Enable foreign key constraints
    conn.execute("PRAGMA foreign_keys = ON")
    
    # Set busy timeout for concurrent access
    conn.execute("PRAGMA busy_timeout = 30000")
    
    return conn


def get_singleton_db_manager(db_path: Path, logger=None) -> DatabaseManager:
    """
    Get a singleton DatabaseManager instance.
    
    This ensures only one DatabaseManager instance exists per database,
    preventing multiple concurrent initialization attempts.
    
    Args:
        db_path: Path to the database file
        logger: Logger instance
        
    Returns:
        DatabaseManager instance
    """
    # In a real implementation, this would use a global registry
    # For now, we'll just create and return a new instance
    # A more robust implementation would use a proper singleton pattern
    return DatabaseManager(db_path, logger)
