"""
Permission and access control system.

Provides role-based access control and permission management.
"""

from fastapi_app.lib.permissions.access_control import DocumentAccessFilter
from fastapi_app.lib.permissions.user_utils import user_has_collection_access, get_user_collections

__all__ = ["DocumentAccessFilter", "user_has_collection_access", "get_user_collections"]
