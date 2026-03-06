"""
File locking system for FastAPI.

Ported from server/lib/locking.py with FastAPI adaptations:
- Removed Flask dependencies (current_app, ApiError)
- Accept db_dir and logger as parameters
- Use stable_id-based file identification instead of paths
- Keep SQLite-based implementation (migrated schema)
"""

import sqlite3
import threading
from datetime import datetime, timezone, timedelta
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Optional, List
import logging

LOCK_TIMEOUT_SECONDS = 90

# Track if locks database has been initialized (to avoid redundant init calls)
_locks_db_initialized: set[str] = set()
_locks_db_init_lock = threading.Lock()


@contextmanager
def get_db_connection(db_dir: Path, logger: logging.Logger):
    """
    Context manager for database connections with proper error handling.

    Uses DELETE journal mode instead of WAL for the locks database because:
    - It's a small database with infrequent writes
    - Locks are short-lived and don't benefit from WAL's read concurrency
    - DELETE mode avoids WAL file corruption under rapid concurrent access

    Args:
        db_dir: Directory containing locks.db
        logger: Logger instance

    Yields:
        sqlite3.Connection: Database connection with row factory enabled
    """
    db_path = db_dir / "locks.db"
    conn = None
    try:
        conn = sqlite3.connect(
            str(db_path),
            timeout=30.0,
            check_same_thread=False
        )
        conn.row_factory = sqlite3.Row
        # Use DELETE journal mode (simpler, avoids WAL corruption issues)
        conn.execute("PRAGMA journal_mode = DELETE")
        # Set busy timeout to wait for locks
        conn.execute("PRAGMA busy_timeout = 30000")
        yield conn
        conn.commit()
    except sqlite3.Error as e:
        logger.error(f"Database error: {e}")
        raise RuntimeError(f"Database error: {e}")
    finally:
        if conn:
            conn.close()


def init_locks_db(db_dir: Path, logger: logging.Logger, force: bool = False) -> None:
    """
    Initialize the locks database with the required schema.
    Creates tables and indexes, and runs any pending migrations.

    This function tracks initialization state to avoid redundant calls
    during concurrent request handling. The database is initialized once
    at application startup via database_init.initialize_all_databases().

    Uses DELETE journal mode instead of WAL to avoid corruption issues.

    Args:
        db_dir: Directory containing locks.db
        logger: Logger instance
        force: If True, force re-initialization (used at startup)
    """
    db_path = db_dir / "locks.db"
    db_key = str(db_path.resolve())

    # Quick check without lock - skip if already initialized
    if not force:
        with _locks_db_init_lock:
            if db_key in _locks_db_initialized:
                return

    # Acquire lock for actual initialization
    with _locks_db_init_lock:
        # Double-check after acquiring lock
        if not force and db_key in _locks_db_initialized:
            return

        db_path.parent.mkdir(parents=True, exist_ok=True)

        # Create database and schema if it doesn't exist
        if not db_path.exists():
            with get_db_connection(db_dir, logger) as conn:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS locks (
                        file_hash TEXT PRIMARY KEY,
                        session_id TEXT NOT NULL,
                        acquired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)

        # Run migrations using centralized runner
        from fastapi_app.lib.core.migration_runner import run_migrations_if_needed
        from fastapi_app.lib.core.migrations.versions import LOCKS_MIGRATIONS

        try:
            run_migrations_if_needed(
                db_path=db_path,
                migrations=LOCKS_MIGRATIONS,
                logger=logger
            )
        except Exception as e:
            logger.error(f"Failed to run migrations for locks.db: {e}")
            raise

        # Create/update indexes with current structure
        try:
            with get_db_connection(db_dir, logger) as conn:
                # Ensure indexes exist with current schema
                conn.execute("""
                    CREATE INDEX IF NOT EXISTS idx_file_id
                    ON locks(file_id)
                """)
                conn.execute("""
                    CREATE INDEX IF NOT EXISTS idx_session
                    ON locks(session_id)
                """)
                conn.execute("""
                    CREATE INDEX IF NOT EXISTS idx_updated
                    ON locks(updated_at)
                """)
                logger.debug(f"Locks database initialized at {db_path}")
        except sqlite3.Error as e:
            logger.error(f"Failed to create indexes: {e}")
            raise RuntimeError(f"Database error: {e}")

        # Mark as initialized
        _locks_db_initialized.add(db_key)


def acquire_lock(file_id: str, session_id: str, db_dir: Path, logger: logging.Logger, max_retries: int = 3) -> bool:
    """
    Tries to acquire a lock for a given file. Returns True on success, False on failure.

    This operation is atomic and handles:
    - Creating new locks
    - Refreshing existing locks owned by the same session
    - Taking over stale locks

    Args:
        file_id: The file's stable_id to lock
        session_id: The session ID requesting the lock
        db_dir: Directory containing locks.db
        logger: Logger instance
        max_retries: Maximum number of retry attempts for transient errors

    Returns:
        bool: True if lock was acquired/refreshed, False if held by another active session

    Raises:
        RuntimeError: If database operations fail after all retries
    """
    import time

    logger.debug(f"[LOCK] Session {session_id[:8]}... attempting to acquire lock for file {file_id[:8]}...")

    # Ensure database is initialized
    init_locks_db(db_dir, logger)

    last_error = None
    for attempt in range(max_retries):
        try:
            return _acquire_lock_impl(file_id, session_id, db_dir, logger)
        except (sqlite3.OperationalError, RuntimeError) as e:
            last_error = e
            error_msg = str(e).lower()
            # Retry on transient errors like disk I/O, busy, or locked
            if any(err in error_msg for err in ['disk i/o', 'busy', 'locked', 'database is malformed']):
                if attempt < max_retries - 1:
                    delay = 0.1 * (2 ** attempt)  # Exponential backoff: 0.1, 0.2, 0.4 seconds
                    logger.warning(
                        f"[LOCK] Transient error on attempt {attempt + 1}/{max_retries}: {e}. "
                        f"Retrying in {delay:.1f}s..."
                    )
                    time.sleep(delay)
                    continue
            # Non-transient error or max retries exceeded
            raise

    # Should not reach here, but handle it
    logger.error(f"[LOCK] Failed to acquire lock after {max_retries} attempts: {last_error}")
    raise RuntimeError(f"Database error after {max_retries} retries: {last_error}")


def _acquire_lock_impl(file_id: str, session_id: str, db_dir: Path, logger: logging.Logger) -> bool:
    """Internal implementation of acquire_lock without retry logic."""
    with get_db_connection(db_dir, logger) as conn:
        # Use IMMEDIATE transaction to get write lock upfront, preventing race conditions
        # This ensures only one transaction can modify locks at a time
        conn.isolation_level = None  # Auto-commit off for explicit transaction control
        conn.execute("BEGIN IMMEDIATE")

        try:
            cursor = conn.cursor()

            # Calculate staleness threshold
            stale_threshold = datetime.now(timezone.utc) - timedelta(seconds=LOCK_TIMEOUT_SECONDS)

            # Check if there's an existing lock
            cursor.execute("""
                SELECT session_id, updated_at
                FROM locks
                WHERE file_id = ?
            """, (file_id,))

            existing = cursor.fetchone()

            if existing:
                existing_session = existing['session_id']
                updated_at = datetime.fromisoformat(existing['updated_at'])
                updated_at_utc = updated_at.replace(tzinfo=timezone.utc)
                is_stale = updated_at_utc < stale_threshold
                age_seconds = (datetime.now(timezone.utc) - updated_at_utc).total_seconds()

                logger.debug(
                    f"[LOCK] Existing lock found: owner={existing_session[:8]}..., "
                    f"age={age_seconds:.1f}s, stale={is_stale}, threshold={LOCK_TIMEOUT_SECONDS}s"
                )

                if existing_session == session_id:
                    # It's our lock, refresh it
                    cursor.execute("""
                        UPDATE locks
                        SET updated_at = CURRENT_TIMESTAMP
                        WHERE file_id = ?
                    """, (file_id,))
                    conn.commit()
                    logger.debug(f"[LOCK] Session {session_id[:8]}... refreshed own lock for file {file_id[:8]}...")
                    return True
                elif is_stale:
                    # Lock is stale, take it over
                    cursor.execute("""
                        UPDATE locks
                        SET session_id = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE file_id = ?
                    """, (session_id, file_id))
                    conn.commit()
                    logger.warning(
                        f"[LOCK] Session {session_id[:8]}... took over stale lock for file {file_id[:8]}... "
                        f"from session {existing_session[:8]}... (was {age_seconds:.1f}s old)"
                    )
                    return True
                else:
                    # Lock is held by another active session - DENY
                    conn.rollback()
                    logger.warning(
                        f"[LOCK] Session {session_id[:8]}... DENIED lock for file {file_id[:8]}.... "
                        f"Held by {existing_session[:8]}... (age={age_seconds:.1f}s, still fresh)"
                    )
                    return False
            else:
                # No existing lock, create new one
                logger.debug(f"[LOCK] No existing lock found for file {file_id[:8]}...")
                cursor.execute("""
                    INSERT INTO locks (file_id, session_id, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                """, (file_id, session_id))
                conn.commit()
                logger.info(f"[LOCK] Session {session_id[:8]}... acquired NEW lock for file {file_id[:8]}...")
                return True
        except Exception as e:
            conn.rollback()
            logger.error(f"[LOCK] Error during lock acquisition: {e}")
            raise


def release_lock(file_id: str, session_id: str, db_dir: Path, logger: logging.Logger) -> Dict[str, str]:
    """
    Releases the lock for a given file if it is held by the current session.

    Args:
        file_id: The file's stable_id to unlock
        session_id: The session ID releasing the lock
        db_dir: Directory containing locks.db
        logger: Logger instance

    Returns:
        dict: Structured response with status, action, and message
            - status: "success" or "error"
            - action: "released", "already_released", "not_owned"
            - message: Human-readable description

    Raises:
        RuntimeError: If attempting to release a lock owned by another session or database error
    """
    logger.debug(f"[LOCK] Session {session_id[:8]}... attempting to release lock for file {file_id[:8]}...")

    # Ensure database is initialized
    init_locks_db(db_dir, logger)

    with get_db_connection(db_dir, logger) as conn:
        cursor = conn.cursor()

        # Check if lock exists and who owns it
        cursor.execute("""
            SELECT session_id
            FROM locks
            WHERE file_id = ?
        """, (file_id,))

        existing = cursor.fetchone()

        if existing:
            existing_session = existing['session_id']
            if existing_session == session_id:
                # Delete the lock
                cursor.execute("""
                    DELETE FROM locks
                    WHERE file_id = ?
                """, (file_id,))
                logger.info(f"[LOCK] Session {session_id[:8]}... released lock for file {file_id[:8]}...")
                return {
                    "status": "success",
                    "action": "released",
                    "message": f"Lock successfully released for file {file_id}"
                }
            else:
                # Attempting to release someone else's lock
                logger.warning(
                    f"[LOCK] Session {session_id[:8]}... DENIED release of lock for file {file_id[:8]}.... "
                    f"Owned by {existing_session[:8]}..."
                )
                raise RuntimeError(
                    f"Session {session_id} attempted to release a lock owned by {existing_session}"
                )
        else:
            # Lock doesn't exist - idempotent success
            logger.info(
                f"[LOCK] Session {session_id[:8]}... attempted to release lock for file {file_id[:8]}..., "
                f"but no lock exists (idempotent success)"
            )
            return {
                "status": "success",
                "action": "already_released",
                "message": f"Lock was already released for file {file_id}"
            }


def cleanup_stale_locks(db_dir: Path, logger: logging.Logger, timeout_seconds: int = LOCK_TIMEOUT_SECONDS) -> int:
    """
    Removes all stale locks from the database.

    Args:
        db_dir: Directory containing locks.db
        logger: Logger instance
        timeout_seconds: Lock timeout in seconds

    Returns:
        int: Number of stale locks purged
    """
    # Ensure database is initialized
    try:
        init_locks_db(db_dir, logger)
    except Exception as e:
        logger.error(f"Could not initialize locks database: {e}")
        return 0

    try:
        with get_db_connection(db_dir, logger) as conn:
            cursor = conn.cursor()

            # Calculate the staleness threshold
            stale_threshold = datetime.now(timezone.utc) - timedelta(seconds=timeout_seconds)

            # Delete stale locks
            cursor.execute("""
                DELETE FROM locks
                WHERE datetime(updated_at) < datetime(?)
            """, (stale_threshold.isoformat(),))

            purged_count = cursor.rowcount

            if purged_count > 0:
                logger.info(f"Purged {purged_count} stale locks")

            return purged_count
    except Exception as e:
        logger.error(f"Error purging stale locks: {e}")
        return 0


def get_all_active_locks(db_dir: Path, logger: logging.Logger, timeout_seconds: int = LOCK_TIMEOUT_SECONDS) -> Dict[str, str]:
    """
    Fetches all non-stale locks and returns a map of file_id -> session_id.

    Args:
        db_dir: Directory containing locks.db
        logger: Logger instance
        timeout_seconds: Lock timeout in seconds

    Returns:
        dict: Dictionary mapping file stable_ids to session IDs for all active locks
    """
    # Ensure database is initialized
    try:
        init_locks_db(db_dir, logger)
    except Exception as e:
        logger.error(f"Could not initialize locks database: {e}")
        return {}

    try:
        with get_db_connection(db_dir, logger) as conn:
            cursor = conn.cursor()

            # Calculate the staleness threshold
            stale_threshold = datetime.now(timezone.utc) - timedelta(seconds=timeout_seconds)

            # Get all non-stale locks
            cursor.execute("""
                SELECT file_id, session_id
                FROM locks
                WHERE datetime(updated_at) >= datetime(?)
            """, (stale_threshold.isoformat(),))

            active_locks = {row['file_id']: row['session_id'] for row in cursor.fetchall()}

            return active_locks
    except Exception as e:
        logger.error(f"Error fetching active locks: {e}")
        return {}


def get_locked_file_ids(db_dir: Path, logger: logging.Logger, session_id: Optional[str] = None, repo=None) -> List[str]:
    """
    Returns a list of file stable_ids which are currently locked.

    Optionally filters by session_id.

    Args:
        db_dir: Directory containing locks.db
        logger: Logger instance
        session_id: If provided, only return locks for this session
        repo: Unused (kept for backward compatibility)

    Returns:
        list: List of file stable_ids that are locked
    """
    active_locks = get_all_active_locks(db_dir, logger)
    locked_file_ids = []

    for file_id, lock_session_id in active_locks.items():
        if session_id and lock_session_id != session_id:
            continue

        locked_file_ids.append(file_id)

    return locked_file_ids


def check_lock(file_id: str, session_id: str, db_dir: Path, logger: logging.Logger) -> Dict[str, any]:
    """
    Checks if a single file is locked by another session.

    Args:
        file_id: The file's stable_id to check
        session_id: The session ID making the check
        db_dir: Directory containing locks.db
        logger: Logger instance

    Returns:
        dict: {"is_locked": bool, "locked_by": Optional[str]}
    """
    # Ensure database is initialized
    try:
        init_locks_db(db_dir, logger)
    except Exception as e:
        logger.error(f"Could not initialize locks database: {e}")
        return {"is_locked": False, "locked_by": None}

    active_locks = get_all_active_locks(db_dir, logger)

    if file_id in active_locks:
        lock_owner = active_locks[file_id]
        if lock_owner != session_id:
            logger.debug(f"File is locked by another session: {lock_owner}")
            return {"is_locked": True, "locked_by": lock_owner}

    return {"is_locked": False, "locked_by": None}


def reset_locks_db_initialized() -> None:
    """
    Reset the locks database initialization tracking.

    This is primarily for testing purposes, to allow re-initialization
    after database files are deleted/recreated between tests.
    """
    with _locks_db_init_lock:
        _locks_db_initialized.clear()
