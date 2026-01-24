"""
Database migration versions.

Each migration should be a separate file in this directory.

Migrations are organized by target database to avoid unnecessary checks
and log noise when running migrations on specific databases.
"""

from .m001_locks_file_id import Migration001LocksFileId
from .m002_sync_tei_collections import Migration002SyncTeiCollections
from .m003_remove_schema_files import Migration003RemoveSchemaFiles
from .m004_encode_pdf_doc_ids import Migration004EncodePdfDocIds
from .m005_add_status_column import Migration005AddStatusColumn
from .m006_add_last_revision_column import Migration006AddLastRevisionColumn
from .m007_add_created_by_column import Migration007AddCreatedByColumn

# Migrations by target database
LOCKS_MIGRATIONS = [
    Migration001LocksFileId,
]

METADATA_MIGRATIONS = [
    Migration002SyncTeiCollections,
    Migration003RemoveSchemaFiles,
    Migration004EncodePdfDocIds,
    Migration005AddStatusColumn,
    Migration006AddLastRevisionColumn,
    Migration007AddCreatedByColumn,
]

# Permissions database migrations (for future schema changes)
# Base schema is created by initialize_permissions_schema() in permissions_db.py
PERMISSIONS_MIGRATIONS = []

# All migrations in order (for tools that need the complete list)
ALL_MIGRATIONS = [
    Migration001LocksFileId,
    Migration002SyncTeiCollections,
    Migration003RemoveSchemaFiles,
    Migration004EncodePdfDocIds,
    Migration005AddStatusColumn,
    Migration006AddLastRevisionColumn,
    Migration007AddCreatedByColumn,
]

__all__ = ["ALL_MIGRATIONS", "LOCKS_MIGRATIONS", "METADATA_MIGRATIONS", "PERMISSIONS_MIGRATIONS"]

