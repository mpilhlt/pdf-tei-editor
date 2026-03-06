"""
Routes for the Metadata Extraction plugin.

Provides an endpoint to extract bibliographic metadata from a PDF
via DOI lookup or LLM-based extraction.
"""

import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_session_manager,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/metadata-extraction", tags=["metadata-extraction"])


@router.get("/extract")
async def extract_metadata(
    stable_id: str = Query(..., description="PDF stable ID"),
    doi: str | None = Query(None, description="DOI string (optional)"),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """
    Extract bibliographic metadata for a PDF document.

    Tries DOI lookup first if doi is provided, otherwise falls back
    to LLM-based extraction via the extraction service.

    Returns:
        JSON with metadata fields (title, authors, date, publisher, etc.)
    """
    from fastapi_app.config import get_settings
    from fastapi_app.lib.services.metadata_extraction import get_metadata_for_document

    # Authenticate
    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # Extract metadata
    metadata = await get_metadata_for_document(
        doi=doi,
        stable_id=stable_id,
    )

    return metadata
