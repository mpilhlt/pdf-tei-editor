"""
Custom routes for RNG Converter plugin.
"""

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import Response
from lxml import etree

from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_db,
    get_file_storage,
    get_session_manager,
)
from fastapi_app.plugins.rng_converter.rng_generator import generate_rng_schema

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/rng-converter", tags=["rng-converter"])


@router.get("/download")
async def download_rng(
    file_id: str = Query(..., description="TEI file stable ID"),
    variant: str = Query("rng-schema", description="Variant name for the schema"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """
    Generate and download RelaxNG schema from TEI document.

    Args:
        file_id: TEI file stable ID
        variant: Variant name for the schema
        session_id: Session ID from query parameter
        x_session_id: Session ID from header
        session_manager: Session manager dependency
        auth_manager: Auth manager dependency

    Returns:
        RelaxNG schema as XML file
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.repository.file_repository import FileRepository

    # Extract session ID (header takes precedence)
    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    # Validate session
    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    # Get user
    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    try:
        db = get_db()
        file_repo = FileRepository(db)
        file_storage = get_file_storage()

        # Get file metadata
        file_metadata = file_repo.get_file_by_stable_id(file_id)
        if not file_metadata:
            raise HTTPException(status_code=404, detail="File not found")

        # Check file type
        if file_metadata.file_type != "tei":
            raise HTTPException(
                status_code=400, detail="File must be a TEI document"
            )

        # Check access via collections
        from fastapi_app.lib.permissions.user_utils import user_has_collection_access

        user_has_access = False
        for collection_id in file_metadata.doc_collections or []:
            if user_has_collection_access(user, collection_id, settings.db_dir):
                user_has_access = True
                break

        if not user_has_access:
            raise HTTPException(status_code=403, detail="Access denied")

        # Read file content
        content_bytes = file_storage.read_file(file_metadata.id, "tei")
        if not content_bytes:
            raise HTTPException(status_code=404, detail="File content not found")

        xml_content = content_bytes.decode("utf-8")

        # Generate RNG schema
        rng_schema = generate_rng_schema(
            xml_content=xml_content,
            variant=variant,
            base_url="",  # Not used anymore since we removed validation instructions
            options={
                "schema_strictness": "balanced",
                "include_namespaces": True,
                "add_documentation": True,
            },
        )

        # Return as downloadable XML file
        filename = f"{file_metadata.doc_id or 'schema'}-{variant}.rng"
        return Response(
            content=rng_schema,
            media_type="application/xml",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"'
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to generate RNG schema: {e}")
        raise HTTPException(status_code=500, detail=str(e))
