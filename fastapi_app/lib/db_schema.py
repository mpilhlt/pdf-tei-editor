"""
Database schema for the SQLite file metadata system.

This module defines the database schema including:
- files table with document-centric organization
- sync_metadata table for synchronization tracking
- All necessary indexes for efficient queries

See fastapi_app/prompts/schema-design.md for complete documentation.
"""

import sqlite3
from typing import Optional


# Main files table
CREATE_FILES_TABLE = """
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,               -- Content hash (SHA-256) - physical file identifier
    stable_id TEXT UNIQUE NOT NULL,    -- Stable short ID for URLs (6+ chars, never changes)
    filename TEXT NOT NULL,            -- Stored filename: {hash}{extension}

    -- Document identifier (groups related files: PDF + TEI versions)
    doc_id TEXT NOT NULL,              -- Document identifier (DOI, custom ID, etc.)
    doc_id_type TEXT DEFAULT 'doi',    -- Type of identifier: 'doi', 'custom', 'isbn', 'arxiv', etc.

    -- File properties
    file_type TEXT NOT NULL,           -- 'pdf', 'tei', 'rng' (determines file extension)
    mime_type TEXT,
    file_size INTEGER,

    -- File-specific metadata (TEI files only)
    label TEXT,                        -- User-assigned label (can override doc_metadata.title)
    variant TEXT,                      -- Variant identifier (TEI files only, NULL for PDF)
    -- status column added by migration 005

    -- Version management (TEI files only)
    version INTEGER DEFAULT 1,         -- Version number for TEI files (NULL for PDF)
    is_gold_standard BOOLEAN DEFAULT 0,-- Mark as gold standard/reference version

    -- Synchronization tracking (see sync-design.md for details)
    deleted BOOLEAN DEFAULT 0,         -- Soft delete marker (for sync, filter with WHERE deleted = 0)
    local_modified_at TIMESTAMP,       -- When local file last changed (triggers sync)
    remote_version INTEGER,            -- Remote version when last synced
    sync_status TEXT DEFAULT 'synced', -- 'synced', 'modified', 'pending_upload', 'pending_delete', 'conflict'
    sync_hash TEXT,                    -- Content hash at last sync (for conflict detection)

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Document-level metadata (populated only for PDF files, inherited by TEI files)
    -- NULL for TEI files - use JOIN to get from PDF when needed
    doc_collections TEXT,              -- JSON array: ["corpus1", "corpus2"] (PDF only)
    doc_metadata TEXT,                 -- JSON object: {author, title, date, doi, ...} (PDF only)

    -- File-specific metadata (extraction method, custom fields, etc.)
    file_metadata TEXT                 -- JSON object: {extraction_method: "grobid", ...}
)
"""

# Sync metadata table
CREATE_SYNC_METADATA_TABLE = """
CREATE TABLE IF NOT EXISTS sync_metadata (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
"""

# All indexes for efficient queries
CREATE_INDEXES = [
    # Core indexes
    "CREATE INDEX IF NOT EXISTS idx_stable_id ON files(stable_id)",
    "CREATE INDEX IF NOT EXISTS idx_doc_id ON files(doc_id)",
    "CREATE INDEX IF NOT EXISTS idx_doc_id_type ON files(doc_id, file_type)",
    "CREATE INDEX IF NOT EXISTS idx_file_type ON files(file_type)",
    "CREATE INDEX IF NOT EXISTS idx_variant ON files(variant)",
    # idx_status is created by migration 005
    "CREATE INDEX IF NOT EXISTS idx_created_at ON files(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_is_gold ON files(is_gold_standard) WHERE is_gold_standard = 1",

    # Sync-related indexes
    "CREATE INDEX IF NOT EXISTS idx_sync_status ON files(sync_status) WHERE sync_status != 'synced'",
    "CREATE INDEX IF NOT EXISTS idx_deleted ON files(deleted) WHERE deleted = 1",
    "CREATE INDEX IF NOT EXISTS idx_local_modified ON files(local_modified_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_remote_version ON files(remote_version)",
]

# Initial sync metadata
INITIAL_SYNC_METADATA = [
    ("last_sync_time", "1970-01-01T00:00:00Z"),
    ("remote_version", "0"),
    ("sync_in_progress", "0"),
    ("last_sync_summary", "{}"),
]


def initialize_database(conn: sqlite3.Connection, logger=None, db_path=None) -> None:
    """
    Initialize database schema with all tables and indexes.

    Creates:
    - files table
    - sync_metadata table
    - All necessary indexes
    - Initial sync metadata

    Also runs any pending migrations if db_path is provided.

    This function is idempotent - safe to call multiple times.

    Args:
        conn: SQLite database connection
        logger: Optional logger instance
        db_path: Optional path to database file (needed for migrations)

    Raises:
        sqlite3.Error: If database initialization fails
    """
    try:
        cursor = conn.cursor()

        if logger:
            logger.info("Creating database tables...")

        # Create tables
        cursor.execute(CREATE_FILES_TABLE)
        cursor.execute(CREATE_SYNC_METADATA_TABLE)

        # Create indexes
        for index_sql in CREATE_INDEXES:
            cursor.execute(index_sql)

        # Insert initial sync metadata (ignore if already exists)
        for key, value in INITIAL_SYNC_METADATA:
            cursor.execute(
                "INSERT OR IGNORE INTO sync_metadata (key, value) VALUES (?, ?)",
                (key, value)
            )

        conn.commit()

        if logger:
            logger.info("Database schema initialized successfully")

        # Run migrations if db_path provided
        if db_path:
            from pathlib import Path
            from .migration_runner import run_migrations_if_needed
            from .migrations.versions import METADATA_MIGRATIONS

            run_migrations_if_needed(
                db_path=Path(db_path),
                migrations=METADATA_MIGRATIONS,
                logger=logger
            )

    except sqlite3.Error as e:
        if logger:
            logger.error(f"Failed to initialize database: {e}")
        raise


def get_schema_version() -> str:
    """
    Get the current schema version.

    Returns:
        Schema version string

    Version history:
        1.0.0 - Initial schema with content-hash based IDs
        2.0.0 - Added stable_id field for permanent short IDs
    """
    return "2.0.0"
