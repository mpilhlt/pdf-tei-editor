"""
Core infrastructure module for PDF-TEI Editor.

Provides database management, schema initialization, and migration system.
This module contains low-level infrastructure components that other modules depend on.

Components:
- DatabaseManager: Connection pooling and transaction management
- Schema initialization and validation
- Migration system for database evolution
- SQLite utilities and helpers
"""

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.migration_runner import run_migrations_if_needed

__all__ = [
    "DatabaseManager",
    "run_migrations_if_needed",
]
