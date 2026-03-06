"""
Database migration system for SQLite databases.

Provides versioned migrations with automatic backup and rollback support.
Follows best practices for safe schema evolution:
- Automatic database backups before migrations
- Transactional migrations with rollback on failure
- Version tracking in the database
- Idempotent migration operations

Usage:
    from fastapi_app.lib.core.migrations import MigrationManager

    manager = MigrationManager(db_path, logger)
    manager.run_migrations()
"""

from .manager import MigrationManager
from .base import Migration

__all__ = ["MigrationManager", "Migration"]
