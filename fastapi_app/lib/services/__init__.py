"""
Service layer for business logic.

Provides high-level services that coordinate repository access and business rules.
"""

from fastapi_app.lib.services.metadata_extraction import get_metadata_for_document
from fastapi_app.lib.services.service_registry import BaseService, get_service_registry

__all__ = [
    "get_metadata_for_document",
    "BaseService",
    "get_service_registry",
]
