"""Routes for KISSKI extraction API."""

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query
from pydantic import BaseModel

from fastapi_app.lib.dependencies import (
    get_auth_manager,
    get_file_repository,
    get_file_storage,
    get_session_manager,
)
from fastapi_app.plugins.kisski.extractor import KisskiExtractor

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/kisski", tags=["kisski"])


class ExtractRequest(BaseModel):
    """Request body for extraction endpoint."""

    model: str
    prompt: str
    stable_id: str | None = None
    text_input: str | None = None
    json_schema: dict[str, Any] | None = None
    temperature: float = 0.1
    max_retries: int = 2


class ExtractResponse(BaseModel):
    """Response from extraction endpoint."""

    success: bool
    data: dict[str, Any] | None = None
    error: str | None = None
    raw_response: str | None = None
    model: str
    extractor: str
    retries: int = 0


@router.post("/extract", response_model=ExtractResponse)
async def extract(
    request: ExtractRequest = Body(...),
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    file_storage=Depends(get_file_storage),
    file_repo=Depends(get_file_repository),
):
    """
    Extract structured JSON data from PDF or text using KISSKI LLM.

    Either stable_id (for PDF) or text_input must be provided.
    If stable_id is provided, the PDF is retrieved from storage and processed.

    Returns JSON data extracted according to the prompt and optional schema.
    """
    from fastapi_app.config import get_settings

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

    # Validate input
    if not request.stable_id and not request.text_input:
        raise HTTPException(
            status_code=400, detail="Either stable_id or text_input must be provided"
        )

    # Get PDF path if stable_id provided
    pdf_path = None
    if request.stable_id:
        # Look up file by stable_id
        file_info = file_repo.get_file_by_stable_id(request.stable_id)
        if not file_info:
            raise HTTPException(
                status_code=404, detail=f"File not found: {request.stable_id}"
            )

        if file_info.file_type != "pdf":
            raise HTTPException(
                status_code=400,
                detail=f"Expected PDF file, got {file_info.file_type}",
            )

        # Get the actual file path from storage
        file_path = file_storage.get_file_path(file_info.id, file_info.file_type)
        if not file_path or not file_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"PDF file not found in storage: {request.stable_id}",
            )
        pdf_path = str(file_path)

    # Perform extraction
    extractor = KisskiExtractor()

    try:
        result = extractor.extract(
            model=request.model,
            prompt=request.prompt,
            pdf_path=pdf_path,
            text_input=request.text_input,
            json_schema=request.json_schema,
            temperature=request.temperature,
            max_retries=request.max_retries,
        )

        return ExtractResponse(
            success=result.get("success", False),
            data=result.get("data"),
            error=result.get("error"),
            raw_response=result.get("raw_response"),
            model=result.get("model", request.model),
            extractor=result.get("extractor", "kisski-neural-chat"),
            retries=result.get("retries", 0),
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        logger.exception(f"Extraction failed: {e}")
        raise HTTPException(status_code=500, detail=f"Extraction failed: {e}")


@router.get("/models")
async def list_models(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """
    List available KISSKI models with their capabilities.

    Returns models with input/output modality information.
    """
    from fastapi_app.config import get_settings

    # Authenticate
    session_id_value = x_session_id or session_id
    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    extractor = KisskiExtractor()

    try:
        models = extractor.get_models_with_capabilities()
        return {"models": models, "pdf_support": extractor.check_pdf_support()}
    except Exception as e:
        logger.exception(f"Failed to retrieve models: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to retrieve models: {e}")
