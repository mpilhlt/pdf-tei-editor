"""
Database migration versions.

Each migration should be a separate file in this directory.
"""

from .m001_locks_file_id import Migration001LocksFileId
from .m002_sync_tei_collections import Migration002SyncTeiCollections
from .m003_remove_schema_files import Migration003RemoveSchemaFiles

# List all migrations in order
ALL_MIGRATIONS = [
    Migration001LocksFileId,
    Migration002SyncTeiCollections,
    Migration003RemoveSchemaFiles,
]

__all__ = ["ALL_MIGRATIONS"]
