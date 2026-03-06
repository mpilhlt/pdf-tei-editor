"""
Repository layer for data access.

Provides data access objects for database operations.
"""

from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.repository.permissions_db import PermissionsDB

__all__ = ["FileRepository", "PermissionsDB"]
