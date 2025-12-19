"""
Database migration versions.

Each migration should be a separate file in this directory.
"""

from .m001_locks_file_id import Migration001LocksFileId

# List all migrations in order
ALL_MIGRATIONS = [
    Migration001LocksFileId,
]

__all__ = ["ALL_MIGRATIONS"]
