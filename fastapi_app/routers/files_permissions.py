"""
File permissions API router for FastAPI.

Only active when access-control.mode = 'granular'.

Implements permission management endpoints:
- GET /api/v1/files/permissions/{stable_id} - Get permissions for artifact
- POST /api/v1/files/set_permissions - Set permissions for artifact
- GET /api/v1/files/access_control_mode - Get current access control mode
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from ..lib.repository.permissions_db import (
    PermissionsDB,
    get_document_permissions,
    set_document_permissions
)
from ..lib.models.models_permissions import (
    DocumentPermissionsModel,
    SetPermissionsRequest,
    AccessControlModeResponse
)
from ..lib.core.dependencies import (
    get_file_repository,
    require_authenticated_user
)
from ..lib.repository.file_repository import FileRepository
from ..lib.utils.config_utils import get_config
from ..lib.utils.logging_utils import get_logger
from ..lib.permissions.acl_utils import (
    user_has_reviewer_role,
    user_is_admin,
    get_access_control_mode as get_mode
)

logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


def get_permissions_db() -> Optional[PermissionsDB]:
    """
    Dependency provider for PermissionsDB.

    Returns None if not in granular mode (caller should check mode first).
    """
    from ..config import get_settings

    mode = get_mode()

    if mode != 'granular':
        return None

    settings = get_settings()
    db_path = settings.db_dir / "permissions.db"

    # Use singleton pattern via module-level cache
    return _PermissionsDBSingleton.get_instance(db_path, logger)


class _PermissionsDBSingleton:
    """Singleton for PermissionsDB to enable connection pooling."""
    _instance: Optional[PermissionsDB] = None

    @classmethod
    def get_instance(cls, db_path, logger=None) -> PermissionsDB:
        if cls._instance is None:
            cls._instance = PermissionsDB(db_path, logger)
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Reset singleton (for testing)."""
        cls._instance = None


@router.get("/access_control_mode", response_model=AccessControlModeResponse)
def get_access_control_mode_endpoint():
    """Get current access control mode and defaults."""
    config = get_config()

    return AccessControlModeResponse(
        mode=get_mode(),
        default_visibility=config.get('access-control.default-visibility', default='collection'),
        default_editability=config.get('access-control.default-editability', default='owner')
    )


@router.get("/permissions/{stable_id}", response_model=DocumentPermissionsModel)
def get_permissions_endpoint(
    stable_id: str,
    current_user: dict = Depends(require_authenticated_user),
    repo: FileRepository = Depends(get_file_repository),
    permissions_db: Optional[PermissionsDB] = Depends(get_permissions_db)
):
    """Get permissions for an artifact (granular mode only)."""
    mode = get_mode()

    if mode != 'granular':
        raise HTTPException(
            status_code=400,
            detail=f"Permissions API only available in granular mode (current: {mode})"
        )

    # Get file to find owner
    file = repo.get_file_by_stable_id(stable_id)
    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    config = get_config()
    default_visibility = config.get('access-control.default-visibility', default='collection')
    default_editability = config.get('access-control.default-editability', default='owner')

    perms = get_document_permissions(
        stable_id,
        permissions_db,
        default_visibility=default_visibility,
        default_editability=default_editability,
        default_owner=file.created_by
    )

    return DocumentPermissionsModel(**perms.__dict__)


@router.post("/set_permissions", response_model=DocumentPermissionsModel)
def set_permissions_endpoint(
    request: SetPermissionsRequest,
    current_user: dict = Depends(require_authenticated_user),
    repo: FileRepository = Depends(get_file_repository),
    permissions_db: Optional[PermissionsDB] = Depends(get_permissions_db)
):
    """Set permissions for an artifact (owner/reviewer only, granular mode only)."""
    mode = get_mode()

    if mode != 'granular':
        raise HTTPException(
            status_code=400,
            detail=f"Permissions API only available in granular mode (current: {mode})"
        )

    # Get current permissions
    file = repo.get_file_by_stable_id(request.stable_id)
    if not file:
        raise HTTPException(status_code=404, detail="File not found")

    current_perms = get_document_permissions(
        request.stable_id,
        permissions_db,
        default_owner=file.created_by
    )

    # Check if user can modify permissions (owner or reviewer)
    is_reviewer = user_has_reviewer_role(current_user)
    is_admin = user_is_admin(current_user)
    is_owner = current_perms.owner == current_user.get('username')

    if not (is_reviewer or is_admin or is_owner):
        raise HTTPException(
            status_code=403,
            detail="Only artifact owner or reviewer can modify permissions"
        )

    # Set new permissions
    updated = set_document_permissions(
        stable_id=request.stable_id,
        visibility=request.visibility,
        editability=request.editability,
        owner=request.owner,
        permissions_db=permissions_db
    )

    return DocumentPermissionsModel(**updated.__dict__)
