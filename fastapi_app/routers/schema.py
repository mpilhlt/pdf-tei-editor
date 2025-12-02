"""
Schema serving API router for FastAPI.

Implements GET /api/v1/schema/{schema_type}/{variant} - Serve schema files by type and variant.

This provides clean, stable URLs for schemas:
- /api/v1/schema/rng/grobid -> serves RNG schema for grobid variant
- /api/v1/schema/xsd/myschema -> serves XSD schema for myschema variant

Schemas are stored in the database with doc_id: schema-{type}-{variant}
This endpoint serves as a proxy to the file serving logic.
"""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from typing import Optional

from ..lib.file_repository import FileRepository
from ..lib.file_storage import FileStorage
from ..lib.dependencies import (
    get_file_repository,
    get_file_storage,
    get_current_user
)
from ..lib.access_control import check_file_access
from ..lib.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/schema", tags=["schema"])


@router.get("/{schema_type}/{variant}")
def serve_schema(
    schema_type: str,
    variant: str,
    repo: FileRepository = Depends(get_file_repository),
    storage: FileStorage = Depends(get_file_storage),
    current_user: Optional[dict] = Depends(get_current_user)
):
    """
    Serve schema by type and variant name.

    Provides clean, stable URLs for schema validation:
    - /api/v1/schema/rng/grobid
    - /api/v1/schema/xsd/myschema

    Args:
        schema_type: Schema type (e.g., 'rng', 'xsd')
        variant: Variant name (e.g., 'grobid', 'gemini')
        repo: File repository (injected)
        storage: File storage (injected)
        current_user: Current user dict (injected)

    Returns:
        FileResponse with schema XML content

    Raises:
        HTTPException: 404 if schema not found, 403 if access denied
    """
    # Construct doc_id for schema lookup
    doc_id = f"schema-{schema_type}-{variant}"

    logger.debug(f"Serving {schema_type.upper()} schema for variant: {variant} (doc_id: {doc_id})")

    # Look up gold standard schema by doc_id
    file_metadata = repo.get_gold_standard(doc_id)

    if not file_metadata:
        logger.warning(f"{schema_type.upper()} schema not found for variant: {variant}")
        raise HTTPException(
            status_code=404,
            detail=f"{schema_type.upper()} schema not found for variant: {variant}"
        )

    # Check read access
    if not check_file_access(file_metadata, current_user, 'read'):
        logger.warning(
            f"Access denied for user {current_user.get('username') if current_user else 'anonymous'} "
            f"to {schema_type.upper()} schema: {variant}"
        )
        raise HTTPException(
            status_code=403,
            detail="Access denied: You don't have permission to view this schema"
        )

    # Get file from storage
    file_path = storage.get_file_path(file_metadata.id, file_metadata.file_type)
    if not file_path or not file_path.exists():
        logger.error(f"{schema_type.upper()} schema in database but not in storage: {doc_id}")
        raise HTTPException(
            status_code=404,
            detail=f"{schema_type.upper()} schema content not found for variant: {variant}"
        )

    logger.info(f"Serving {schema_type.upper()} schema for variant: {variant}")

    return FileResponse(file_path, media_type="application/xml")
