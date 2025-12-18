"""
File locking system for FastAPI.

Ported from server/lib/locking.py with FastAPI adaptations:
- Removed Flask dependencies (current_app, ApiError)
- Accept db_dir and logger as parameters
- Use hash-based file identification instead of paths
- Keep SQLite-based implementation (same schema)
"""

import sqlite3
from datetime import datetime, timezone, timedelta
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Optional, List
import logging

LOCK_TIMEOUT_SECONDS = 90


@contextmanager
def get_db_connection(db_dir: Path, logger: logging.Logger):
    """
    Context manager for database connections with proper error handling.

    Args:
        db_dir: Directory containing locks.db
        logger: Logger instance

    Yields:
        sqlite3.Connection: Database connection with row factory enabled
    """
    conn = None
    try:
        db_path = db_dir / "locks.db"
        conn = sqlite3.connect(str(db_path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        # Enable WAL mode for better concurrent access
        conn.execute("PRAGMA journal_mode=WAL")
        yield conn
        conn.commit()
    except sqlite3.Error as e:
        if conn:
            conn.rollback()
        logger.error(f"Database error: {e}")
        raise RuntimeError(f"Database error: {e}")
    finally:
        if conn:
            conn.close()


def init_locks_db(db_dir: Path, logger: logging.Logger) -> None:
    """
    Initialize the locks database with the required schema.
    Creates tables and indexes if they don't exist.

    Args:
        db_dir: Directory containing locks.db
        logger: Logger instance
    """
    with get_db_connection(db_dir, logger) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS locks (
                file_hash TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                acquired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_session
            ON locks(session_id)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_updated
            ON locks(updated_at)
        """)
        logger.debug(f"Locks database initialized at {db_dir / 'locks.db'}")


def acquire_lock(file_hash: str, session_id: str, db_dir: Path, logger: logging.Logger) -> bool:
    """
    Tries to acquire a lock for a given file. Returns True on success, False on failure.

    This operation is atomic and handles:
    - Creating new locks
    - Refreshing existing locks owned by the same session
    - Taking over stale locks

    Args:
        file_hash: The file hash to lock
        session_id: The session ID requesting the lock
        db_dir: Directory containing locks.db
        logger: Logger instance

    Returns:
        bool: True if lock was acquired/refreshed, False if held by another active session

    Raises:
        RuntimeError: If database operations fail
    """
    logger.debug(f"[LOCK] Session {session_id[:8]}... attempting to acquire lock for {file_hash[:8]}...")

    # Ensure database is initialized
    init_locks_db(db_dir, logger)

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
                WHERE file_hash = ?
            """, (file_hash,))

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
                        WHERE file_hash = ?
                    """, (file_hash,))
                    conn.commit()
                    logger.info(f"[LOCK] Session {session_id[:8]}... refreshed own lock for {file_hash[:8]}...")
                    return True
                elif is_stale:
                    # Lock is stale, take it over
                    cursor.execute("""
                        UPDATE locks
                        SET session_id = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE file_hash = ?
                    """, (session_id, file_hash))
                    conn.commit()
                    logger.warning(
                        f"[LOCK] Session {session_id[:8]}... took over stale lock for {file_hash[:8]}... "
                        f"from session {existing_session[:8]}... (was {age_seconds:.1f}s old)"
                    )
                    return True
                else:
                    # Lock is held by another active session - DENY
                    conn.rollback()
                    logger.warning(
                        f"[LOCK] Session {session_id[:8]}... DENIED lock for {file_hash[:8]}.... "
                        f"Held by {existing_session[:8]}... (age={age_seconds:.1f}s, still fresh)"
                    )
                    return False
            else:
                # No existing lock, create new one
                logger.debug(f"[LOCK] No existing lock found for {file_hash[:8]}...")
                cursor.execute("""
                    INSERT INTO locks (file_hash, session_id, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                """, (file_hash, session_id))
                conn.commit()
                logger.info(f"[LOCK] Session {session_id[:8]}... acquired NEW lock for {file_hash[:8]}...")
                return True
        except Exception as e:
            conn.rollback()
            logger.error(f"[LOCK] Error during lock acquisition: {e}")
            raise


def transfer_lock(old_hash: str, new_hash: str, session_id: str, db_dir: Path, logger: logging.Logger) -> bool:
    """
    Transfers a lock from one file hash to another for the same session.

    This is used when a file's content changes and gets a new hash.
    The lock on the old hash is removed and a new lock is created on the new hash.

    Args:
        old_hash: The original file hash
        new_hash: The new file hash
        session_id: The session ID that owns the lock
        db_dir: Directory containing locks.db
        logger: Logger instance

    Returns:
        bool: True if transfer succeeded, False otherwise

    Raises:
        RuntimeError: If the old lock is not owned by this session or database error
    """
    logger.debug(f"[LOCK] Session {session_id[:8]}... transferring lock from {old_hash[:8]}... to {new_hash[:8]}...")

    # Ensure database is initialized
    init_locks_db(db_dir, logger)

    with get_db_connection(db_dir, logger) as conn:
        cursor = conn.cursor()

        # Check if old lock exists and who owns it
        cursor.execute("""
            SELECT session_id
            FROM locks
            WHERE file_hash = ?
        """, (old_hash,))

        existing = cursor.fetchone()

        if not existing:
            logger.warning(f"[LOCK] No lock found on old hash {old_hash[:8]}... for transfer")
            return False

        existing_session = existing['session_id']
        if existing_session != session_id:
            logger.error(
                f"[LOCK] Cannot transfer lock from {old_hash[:8]}... to {new_hash[:8]}.... "
                f"Old lock owned by {existing_session[:8]}..., not {session_id[:8]}..."
            )
            raise RuntimeError(
                f"Cannot transfer lock: old hash is locked by session {existing_session}"
            )

        # Delete old lock and create new one in a transaction
        cursor.execute("DELETE FROM locks WHERE file_hash = ?", (old_hash,))
        cursor.execute("""
            INSERT INTO locks (file_hash, session_id, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
        """, (new_hash, session_id))

        logger.info(f"[LOCK] Session {session_id[:8]}... transferred lock from {old_hash[:8]}... to {new_hash[:8]}...")
        return True


def release_lock(file_hash: str, session_id: str, db_dir: Path, logger: logging.Logger) -> Dict[str, str]:
    """
    Releases the lock for a given file if it is held by the current session.

    Args:
        file_hash: The file hash to unlock
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
    logger.debug(f"[LOCK] Session {session_id[:8]}... attempting to release lock for {file_hash[:8]}...")

    # Ensure database is initialized
    init_locks_db(db_dir, logger)

    with get_db_connection(db_dir, logger) as conn:
        cursor = conn.cursor()

        # Check if lock exists and who owns it
        cursor.execute("""
            SELECT session_id
            FROM locks
            WHERE file_hash = ?
        """, (file_hash,))

        existing = cursor.fetchone()

        if existing:
            existing_session = existing['session_id']
            if existing_session == session_id:
                # Delete the lock
                cursor.execute("""
                    DELETE FROM locks
                    WHERE file_hash = ?
                """, (file_hash,))
                logger.info(f"[LOCK] Session {session_id[:8]}... released lock for {file_hash[:8]}...")
                return {
                    "status": "success",
                    "action": "released",
                    "message": f"Lock successfully released for {file_hash}"
                }
            else:
                # Attempting to release someone else's lock
                logger.warning(
                    f"[LOCK] Session {session_id[:8]}... DENIED release of lock for {file_hash[:8]}.... "
                    f"Owned by {existing_session[:8]}..."
                )
                raise RuntimeError(
                    f"Session {session_id} attempted to release a lock owned by {existing_session}"
                )
        else:
            # Lock doesn't exist - idempotent success
            logger.info(
                f"[LOCK] Session {session_id[:8]}... attempted to release lock for {file_hash[:8]}..., "
                f"but no lock exists (idempotent success)"
            )
            return {
                "status": "success",
                "action": "already_released",
                "message": f"Lock was already released for {file_hash}"
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
    Fetches all non-stale locks and returns a map of file_hash -> session_id.

    Args:
        db_dir: Directory containing locks.db
        logger: Logger instance
        timeout_seconds: Lock timeout in seconds

    Returns:
        dict: Dictionary mapping file hashes to session IDs for all active locks
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
                SELECT file_hash, session_id
                FROM locks
                WHERE datetime(updated_at) >= datetime(?)
            """, (stale_threshold.isoformat(),))

            active_locks = {row['file_hash']: row['session_id'] for row in cursor.fetchall()}

            return active_locks
    except Exception as e:
        logger.error(f"Error fetching active locks: {e}")
        return {}


def get_locked_file_ids(db_dir: Path, logger: logging.Logger, session_id: Optional[str] = None, repo=None) -> List[str]:
    """
    Returns a list of file stable_ids which are currently locked.

    Optionally filters by session_id and converts hashes to stable_ids.

    Args:
        db_dir: Directory containing locks.db
        logger: Logger instance
        session_id: If provided, only return locks for this session
        repo: Optional FileRepository instance to get stable_ids

    Returns:
        list: List of file stable_ids (or hashes if no repo provided) that are locked
    """
    active_locks = get_all_active_locks(db_dir, logger)
    locked_file_ids = []

    for file_hash, lock_session_id in active_locks.items():
        if session_id and lock_session_id != session_id:
            continue

        # Get stable_id if repository provided
        if repo:
            try:
                # Include deleted files since locks can exist on deleted files
                file_metadata = repo.get_file_by_id(file_hash, include_deleted=True)
                if file_metadata and file_metadata.stable_id:
                    file_id = file_metadata.stable_id
                else:
                    file_id = file_hash
            except Exception as e:
                logger.warning(f"Could not get stable_id for hash {file_hash}: {e}")
                file_id = file_hash
        else:
            file_id = file_hash

        locked_file_ids.append(file_id)

    return locked_file_ids


def check_lock(file_hash: str, session_id: str, db_dir: Path, logger: logging.Logger) -> Dict[str, any]:
    """
    Checks if a single file is locked by another session.

    Args:
        file_hash: The file hash to check
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

    if file_hash in active_locks:
        lock_owner = active_locks[file_hash]
        if lock_owner != session_id:
            logger.debug(f"File is locked by another session: {lock_owner}")
            return {"is_locked": True, "locked_by": lock_owner}

    return {"is_locked": False, "locked_by": None}
