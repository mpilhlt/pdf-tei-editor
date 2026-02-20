"""
Document permissions database management (granular mode only).

Stores document-level visibility/editability permissions in SQLite database.
Uses DELETE journal mode (simple database with infrequent writes).
"""

import sqlite3
import queue
from datetime import datetime, timezone
from contextlib import contextmanager
from pathlib import Path
from typing import Optional, Generator
from dataclasses import dataclass
import logging

from fastapi_app.lib.core import sqlite_utils

logger = logging.getLogger(__name__)


@dataclass
class DocumentPermissions:
    """Document permission data."""
    stable_id: str
    visibility: str      # 'collection' | 'owner'
    editability: str     # 'collection' | 'owner'
    owner: str           # Username (never None)
    created_at: datetime
    updated_at: datetime


class PermissionsDB:
    """
    Manages permissions database connections with pooling.

    Uses DELETE journal mode (not WAL) since this is a simple database
    with infrequent writes that doesn't benefit from WAL's read concurrency.
    """

    def __init__(self, db_path: Path, logger=None):
        self.db_path = db_path
        self.logger = logger or logging.getLogger(__name__)
        self._pool = queue.Queue()
        self._ensure_db_exists()

    def _ensure_db_exists(self) -> None:
        """Ensure database and schema exist with migrations."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        # Use per-database lock to prevent concurrent schema initialization
        with sqlite_utils.with_db_lock(self.db_path):
            conn = sqlite3.connect(str(self.db_path), timeout=60.0, isolation_level=None)
            try:
                conn.execute("PRAGMA journal_mode = DELETE")
                conn.execute("PRAGMA busy_timeout = 30000")
                conn.execute("PRAGMA foreign_keys = ON")
                initialize_permissions_schema(conn, self.logger, db_path=self.db_path)
            finally:
                conn.close()

    @contextmanager
    def get_connection(self) -> Generator[sqlite3.Connection, None, None]:
        """Context manager for database connections with pooling."""
        try:
            conn = self._pool.get(block=False)
        except queue.Empty:
            conn = sqlite3.connect(
                str(self.db_path),
                timeout=60.0,
                check_same_thread=False,
                isolation_level=None
            )
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout = 30000")
            conn.execute("PRAGMA foreign_keys = ON")

        try:
            yield conn
        finally:
            try:
                conn.rollback()
            except sqlite3.OperationalError:
                pass
            self._pool.put(conn)


def initialize_permissions_schema(conn: sqlite3.Connection, logger=None, db_path=None) -> None:
    """
    Initialize permissions database schema.

    Creates tables and runs any pending migrations.

    Args:
        conn: SQLite database connection
        logger: Optional logger instance
        db_path: Optional path to database file (needed for migrations)
    """
    try:
        cursor = conn.cursor()

        if logger:
            logger.info("Creating permissions tables...")

        # Create document_permissions table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS document_permissions (
                stable_id TEXT PRIMARY KEY,
                visibility TEXT NOT NULL DEFAULT 'collection',
                editability TEXT NOT NULL DEFAULT 'owner',
                owner TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CHECK (visibility IN ('collection', 'owner')),
                CHECK (editability IN ('collection', 'owner'))
            )
        """)

        # Create indexes
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_permissions_owner ON document_permissions(owner)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_permissions_visibility ON document_permissions(visibility)")

        conn.commit()

        if logger:
            logger.info("Permissions database schema initialized")

        # Run migrations if db_path provided
        if db_path:
            from pathlib import Path
            from fastapi_app.lib.core.migration_runner import run_migrations_if_needed
            from fastapi_app.lib.core.migrations.versions import PERMISSIONS_MIGRATIONS

            run_migrations_if_needed(
                db_path=Path(db_path),
                migrations=PERMISSIONS_MIGRATIONS,
                logger=logger
            )

    except sqlite3.Error as e:
        if logger:
            logger.error(f"Failed to initialize permissions database: {e}")
        raise


def get_document_permissions(
    stable_id: str,
    permissions_db: PermissionsDB,
    default_visibility: str = 'collection',
    default_editability: str = 'owner',
    default_owner: Optional[str] = None
) -> DocumentPermissions:
    """
    Get permissions for an artifact.

    Returns defaults if not found in database.

    Args:
        stable_id: Artifact stable ID
        permissions_db: PermissionsDB instance (use dependency injection)
        default_visibility: Default visibility if not in database
        default_editability: Default editability if not in database
        default_owner: Default owner if not in database
    """
    with permissions_db.get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM document_permissions WHERE stable_id = ?",
            (stable_id,)
        ).fetchone()

        if row:
            return DocumentPermissions(
                stable_id=row['stable_id'],
                visibility=row['visibility'],
                editability=row['editability'],
                owner=row['owner'],
                created_at=datetime.fromisoformat(row['created_at']),
                updated_at=datetime.fromisoformat(row['updated_at'])
            )
        else:
            # Return defaults
            return DocumentPermissions(
                stable_id=stable_id,
                visibility=default_visibility,
                editability=default_editability,
                owner=default_owner or 'unknown',
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc)
            )


def set_document_permissions(
    stable_id: str,
    visibility: str,
    editability: str,
    owner: str,
    permissions_db: PermissionsDB
) -> DocumentPermissions:
    """
    Set permissions for an artifact.

    Args:
        stable_id: Artifact stable ID
        visibility: 'collection' or 'owner'
        editability: 'collection' or 'owner'
        owner: Username (required)
        permissions_db: PermissionsDB instance (use dependency injection)
    """
    # Validate inputs
    if visibility not in ('collection', 'owner'):
        raise ValueError(f"Invalid visibility: {visibility}")
    if editability not in ('collection', 'owner'):
        raise ValueError(f"Invalid editability: {editability}")
    if not owner:
        raise ValueError("Owner is required")

    now = datetime.now(timezone.utc).isoformat()

    with permissions_db.get_connection() as conn:
        # UPSERT into document_permissions
        conn.execute("""
            INSERT INTO document_permissions (stable_id, visibility, editability, owner, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(stable_id) DO UPDATE SET
                visibility = excluded.visibility,
                editability = excluded.editability,
                owner = excluded.owner,
                updated_at = excluded.updated_at
        """, (stable_id, visibility, editability, owner, now, now))
        conn.commit()

    return DocumentPermissions(
        stable_id=stable_id,
        visibility=visibility,
        editability=editability,
        owner=owner,
        created_at=datetime.fromisoformat(now),
        updated_at=datetime.fromisoformat(now)
    )


def delete_document_permissions(stable_id: str, permissions_db: PermissionsDB) -> bool:
    """
    Delete permissions record for an artifact (when artifact is deleted).

    Args:
        stable_id: Artifact stable ID
        permissions_db: PermissionsDB instance (use dependency injection)
    """
    with permissions_db.get_connection() as conn:
        conn.execute("DELETE FROM document_permissions WHERE stable_id = ?", (stable_id,))
        conn.commit()
        return True
