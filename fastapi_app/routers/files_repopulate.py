"""
File field repopulation API router for FastAPI.

Implements POST /api/files/repopulate - Re-extract fields from TEI documents.

This endpoint re-populates database fields by parsing TEI files and extracting
metadata. Useful for maintenance when extraction logic has been updated.

Security:
- Requires authentication
- Requires admin role
"""

from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..config import get_settings
from ..lib.dependencies import (
    get_db,
    require_authenticated_user
)
from ..lib.database import DatabaseManager
from ..lib.logging_utils import get_logger
from ..lib.tei_utils import extract_last_revision_status, extract_revision_timestamp
from ..lib.migrations.utils import repopulate_column_from_tei_files


logger = get_logger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


# Registry of repopulatable fields
# Maps field name to (column_name, extract_function, description)
REPOPULATABLE_FIELDS = {
    "status": {
        "column": "status",
        "extract_function": extract_last_revision_status,
        "description": "revision status"
    },
    "last_revision": {
        "column": "last_revision",
        "extract_function": extract_revision_timestamp,
        "description": "last revision timestamp"
    }
}


class RepopulateRequest(BaseModel):
    """Request body for repopulate endpoint."""
    fields: Optional[List[str]] = None  # None or empty means all fields


class FieldResult(BaseModel):
    """Result for a single field repopulation."""
    field: str
    updated: int
    errors: int
    skipped: int
    total: int


class RepopulateResponse(BaseModel):
    """Response from repopulate endpoint."""
    success: bool
    results: List[FieldResult]
    message: str


@router.post("/repopulate", response_model=RepopulateResponse)
def repopulate_fields(
    body: RepopulateRequest,
    db: DatabaseManager = Depends(get_db),
    current_user: dict = Depends(require_authenticated_user)
) -> RepopulateResponse:
    """
    Re-populate database fields from TEI documents.

    Extracts metadata from TEI files and updates the corresponding database fields.
    This is useful for maintenance when extraction logic has been updated or when
    fields need to be refreshed.

    Available fields:
    - status: Revision status from revisionDesc/change/@status
    - last_revision: Timestamp from revisionDesc/change/@when

    Security:
    - Admin role required

    Args:
        body: RepopulateRequest with optional list of fields to repopulate
        db: Database manager (injected)
        current_user: Current user dict (injected)

    Returns:
        RepopulateResponse with statistics for each field

    Raises:
        HTTPException: 403 if user is not admin
        HTTPException: 400 if invalid field name provided
    """
    # Check admin role
    user_roles = current_user.get('roles', [])
    is_admin = '*' in user_roles or 'admin' in user_roles

    if not is_admin:
        logger.warning(
            f"Non-admin user {current_user['username']} attempted to repopulate fields"
        )
        raise HTTPException(
            status_code=403,
            detail="Admin role required to repopulate fields"
        )

    # Determine which fields to repopulate
    if body.fields:
        # Validate field names
        invalid_fields = [f for f in body.fields if f not in REPOPULATABLE_FIELDS]
        if invalid_fields:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid field names: {invalid_fields}. "
                       f"Available fields: {list(REPOPULATABLE_FIELDS.keys())}"
            )
        fields_to_process = body.fields
    else:
        # All fields
        fields_to_process = list(REPOPULATABLE_FIELDS.keys())

    logger.info(
        f"Starting field repopulation for fields: {fields_to_process}, "
        f"user={current_user['username']}"
    )

    # Get files directory
    settings = get_settings()
    files_dir = settings.data_root / "files"

    results = []

    with db.get_connection() as conn:
        for field_name in fields_to_process:
            field_config = REPOPULATABLE_FIELDS[field_name]

            logger.info(f"Repopulating field: {field_name}")

            stats = repopulate_column_from_tei_files(
                conn=conn,
                files_dir=files_dir,
                column_name=field_config["column"],
                extract_function=field_config["extract_function"],
                logger=logger,
                column_description=field_config["description"]
            )

            results.append(FieldResult(
                field=field_name,
                updated=stats["updated"],
                errors=stats["errors"],
                skipped=stats["skipped"],
                total=stats["total"]
            ))

        # Commit all changes
        conn.commit()

    total_updated = sum(r.updated for r in results)
    total_errors = sum(r.errors for r in results)

    message = f"Repopulated {len(fields_to_process)} field(s): {total_updated} updates, {total_errors} errors"
    logger.info(message)

    return RepopulateResponse(
        success=total_errors == 0,
        results=results,
        message=message
    )
