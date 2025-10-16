import os
import sqlite3
from datetime import datetime, timezone, timedelta
from contextlib import contextmanager
from flask import current_app
from .hash_utils import resolve_path_to_hash
from .server_utils import ApiError

LOCK_TIMEOUT_SECONDS = 90


def get_db_path():
    """Returns the path to the locks database."""
    db_dir = current_app.config.get("DB_DIR", "data/db")
    return os.path.join(db_dir, "locks-flask.db")


@contextmanager
def get_db_connection():
    """
    Context manager for database connections with proper error handling.

    Yields:
        sqlite3.Connection: Database connection with row factory enabled
    """
    conn = None
    try:
        db_path = get_db_path()
        conn = sqlite3.connect(db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        # Enable WAL mode for better concurrent access
        conn.execute("PRAGMA journal_mode=WAL")
        yield conn
        conn.commit()
    except sqlite3.Error as e:
        if conn:
            conn.rollback()
        current_app.logger.error(f"Database error: {e}")
        raise RuntimeError(f"Database error: {e}")
    finally:
        if conn:
            conn.close()


def init_locks_db():
    """
    Initialize the locks database with the required schema.
    Creates tables and indexes if they don't exist.
    """
    with get_db_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS locks (
                file_path TEXT PRIMARY KEY,
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
        current_app.logger.debug(f"Locks database initialized at {get_db_path()}")


def acquire_lock(file_path, session_id):
    """
    Tries to acquire a lock for a given file. Returns True on success, False on failure.

    This operation is atomic and handles:
    - Creating new locks
    - Refreshing existing locks owned by the same session
    - Taking over stale locks

    Args:
        file_path (str): The path to the file to lock
        session_id (str): The session ID requesting the lock

    Returns:
        bool: True if lock was acquired/refreshed, False if held by another active session

    Raises:
        RuntimeError: If database operations fail
    """
    current_app.logger.debug(f"[LOCK] Session {session_id[:8]}... attempting to acquire lock for {file_path}")

    # Ensure database is initialized
    init_locks_db()

    with get_db_connection() as conn:
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
                WHERE file_path = ?
            """, (file_path,))

            existing = cursor.fetchone()

            if existing:
                existing_session = existing['session_id']
                updated_at = datetime.fromisoformat(existing['updated_at'])
                updated_at_utc = updated_at.replace(tzinfo=timezone.utc)
                is_stale = updated_at_utc < stale_threshold
                age_seconds = (datetime.now(timezone.utc) - updated_at_utc).total_seconds()

                current_app.logger.debug(
                    f"[LOCK] Existing lock found: owner={existing_session[:8]}..., "
                    f"age={age_seconds:.1f}s, stale={is_stale}, threshold={LOCK_TIMEOUT_SECONDS}s"
                )

                if existing_session == session_id:
                    # It's our lock, refresh it
                    cursor.execute("""
                        UPDATE locks
                        SET updated_at = CURRENT_TIMESTAMP
                        WHERE file_path = ?
                    """, (file_path,))
                    conn.commit()
                    current_app.logger.info(f"[LOCK] Session {session_id[:8]}... refreshed own lock for {file_path}")
                    return True
                elif is_stale:
                    # Lock is stale, take it over
                    cursor.execute("""
                        UPDATE locks
                        SET session_id = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE file_path = ?
                    """, (session_id, file_path))
                    conn.commit()
                    current_app.logger.warning(
                        f"[LOCK] Session {session_id[:8]}... took over stale lock for {file_path} "
                        f"from session {existing_session[:8]}... (was {age_seconds:.1f}s old)"
                    )
                    return True
                else:
                    # Lock is held by another active session - DENY
                    conn.rollback()
                    current_app.logger.warning(
                        f"[LOCK] Session {session_id[:8]}... DENIED lock for {file_path}. "
                        f"Held by {existing_session[:8]}... (age={age_seconds:.1f}s, still fresh)"
                    )
                    return False
            else:
                # No existing lock, create new one
                current_app.logger.debug(f"[LOCK] No existing lock found for {file_path}")
                cursor.execute("""
                    INSERT INTO locks (file_path, session_id, updated_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                """, (file_path, session_id))
                conn.commit()
                current_app.logger.info(f"[LOCK] Session {session_id[:8]}... acquired NEW lock for {file_path}")
                return True
        except Exception as e:
            conn.rollback()
            current_app.logger.error(f"[LOCK] Error during lock acquisition: {e}")
            raise


def release_lock(file_path, session_id):
    """
    Releases the lock for a given file if it is held by the current session.

    Args:
        file_path (str): The path to the file to unlock
        session_id (str): The session ID releasing the lock

    Returns:
        dict: Structured response with status, action, and message
            - status: "success" or "error"
            - action: "released", "already_released", "not_owned"
            - message: Human-readable description

    Raises:
        ApiError: If attempting to release a lock owned by another session
        RuntimeError: If database operations fail
    """
    current_app.logger.debug(f"[LOCK] Session {session_id[:8]}... attempting to release lock for {file_path}")

    # Ensure database is initialized
    init_locks_db()

    with get_db_connection() as conn:
        cursor = conn.cursor()

        # Check if lock exists and who owns it
        cursor.execute("""
            SELECT session_id
            FROM locks
            WHERE file_path = ?
        """, (file_path,))

        existing = cursor.fetchone()

        if existing:
            existing_session = existing['session_id']
            if existing_session == session_id:
                # Delete the lock
                cursor.execute("""
                    DELETE FROM locks
                    WHERE file_path = ?
                """, (file_path,))
                current_app.logger.info(f"[LOCK] Session {session_id[:8]}... released lock for {file_path}")
                return {
                    "status": "success",
                    "action": "released",
                    "message": f"Lock successfully released for {file_path}"
                }
            else:
                # Attempting to release someone else's lock
                current_app.logger.warning(
                    f"[LOCK] Session {session_id[:8]}... DENIED release of lock for {file_path}. "
                    f"Owned by {existing_session[:8]}..."
                )
                raise ApiError(
                    f"Session {session_id} attempted to release a lock owned by {existing_session}",
                    status_code=409
                )
        else:
            # Lock doesn't exist - idempotent success
            current_app.logger.info(
                f"[LOCK] Session {session_id[:8]}... attempted to release lock for {file_path}, "
                f"but no lock exists (idempotent success)"
            )
            return {
                "status": "success",
                "action": "already_released",
                "message": f"Lock was already released for {file_path}"
            }


def purge_stale_locks():
    """
    Removes all stale locks from the database.

    Returns:
        int: Number of stale locks purged
    """
    # Ensure database is initialized
    try:
        init_locks_db()
    except Exception as e:
        current_app.logger.error(f"Could not initialize locks database: {e}")
        return 0

    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()

            # Calculate the staleness threshold
            stale_threshold = datetime.now(timezone.utc) - timedelta(seconds=LOCK_TIMEOUT_SECONDS)

            # Delete stale locks
            cursor.execute("""
                DELETE FROM locks
                WHERE datetime(updated_at) < datetime(?)
            """, (stale_threshold.isoformat(),))

            purged_count = cursor.rowcount

            if purged_count > 0:
                current_app.logger.info(f"Purged {purged_count} stale locks")

            return purged_count
    except Exception as e:
        current_app.logger.error(f"Error purging stale locks: {e}")
        return 0


def get_all_active_locks():
    """
    Fetches all non-stale locks and returns a map of file_path -> session_id.

    Returns:
        dict: Dictionary mapping file paths to session IDs for all active locks
    """
    # Ensure database is initialized
    try:
        init_locks_db()
    except Exception as e:
        current_app.logger.error(f"Could not initialize locks database: {e}")
        return {}

    try:
        with get_db_connection() as conn:
            cursor = conn.cursor()

            # Calculate the staleness threshold
            stale_threshold = datetime.now(timezone.utc) - timedelta(seconds=LOCK_TIMEOUT_SECONDS)

            # Get all non-stale locks
            cursor.execute("""
                SELECT file_path, session_id
                FROM locks
                WHERE datetime(updated_at) >= datetime(?)
            """, (stale_threshold.isoformat(),))

            active_locks = {row['file_path']: row['session_id'] for row in cursor.fetchall()}

            return active_locks
    except Exception as e:
        current_app.logger.error(f"Error fetching active locks: {e}")
        return {}


def get_locked_file_ids(session_id=None):
    """
    Returns a list of file IDs (hashes) which are currently locked.

    Args:
        session_id (str, optional): If provided, only return locks for this session

    Returns:
        list: List of file ID hashes that are locked
    """
    active_locks = get_all_active_locks()
    locked_file_ids = []

    for file_path, lock_session_id in active_locks.items():
        if session_id and lock_session_id != session_id:
            continue

        # Remove /data/ prefix if present
        file_path = file_path.removeprefix("/data/")

        try:
            file_id = resolve_path_to_hash(file_path)
            locked_file_ids.append(file_id)
        except KeyError:
            # File was deleted but lock remains - skip it
            # This is normal when files are deleted - locks will be purged by cleanup job
            current_app.logger.debug(f"Skipping lock for deleted file: {file_path}")
            continue

    return locked_file_ids


def check_lock(file_path, session_id):
    """
    Checks if a single file is locked by another session.

    Args:
        file_path (str): The path to check
        session_id (str): The session ID making the check

    Returns:
        dict: {"is_locked": bool} - True if locked by another session
    """
    # Ensure database is initialized
    try:
        init_locks_db()
    except Exception as e:
        current_app.logger.error(f"Could not initialize locks database: {e}")
        return {"is_locked": False}

    active_locks = get_all_active_locks()

    if file_path in active_locks and active_locks[file_path] != session_id:
        current_app.logger.debug(f"File is locked by another session: {active_locks[file_path]}")
        return {"is_locked": True}

    return {"is_locked": False}
