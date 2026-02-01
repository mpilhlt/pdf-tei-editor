"""
Custom routes for the test plugin.

This demonstrates how plugins can define their own API routes
beyond the generic /api/plugins/{id}/execute endpoint.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Any, Dict, List, Optional
from fastapi_app.lib.dependencies import get_current_user
from fastapi_app.lib.service_registry import get_service_registry, ExtractionService, ExtractionParams, ExtractionResult

router = APIRouter(prefix="/api/plugins/test-plugin", tags=["test-plugin"])


class AnalyzeRequest(BaseModel):
    """Request body for direct analysis endpoint."""

    text: str


class AnalyzeResponse(BaseModel):
    """Response for direct analysis endpoint."""

    word_count: int
    char_count: int
    message: str


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze_text(request: AnalyzeRequest) -> AnalyzeResponse:
    """
    Custom endpoint for quick text analysis.

    This is an example of a plugin-specific route that provides
    a simplified interface compared to the generic execute endpoint.

    Args:
        request: Analysis request with text

    Returns:
        Quick analysis result
    """
    text = request.text
    word_count = len(text.split())
    char_count = len(text)

    return AnalyzeResponse(
        word_count=word_count,
        char_count=char_count,
        message=f"Analyzed {word_count} words in {char_count} characters",
    )


@router.get("/status")
async def get_status() -> dict:
    """
    Get plugin status.

    Returns:
        Plugin status information
    """
    return {
        "plugin": "test-plugin",
        "status": "active",
        "version": "1.0.0",
    }


class ServiceRegistryResponse(BaseModel):
    """Response for service registry operations."""

    success: bool
    message: str
    data: Optional[Dict[str, Any]] = None


class ExtractionRequest(BaseModel):
    """Request body for extraction service test."""

    model: str = "test-model"
    prompt: str = "Extract key information"
    text_input: Optional[str] = None
    json_schema: Optional[Dict[str, Any]] = None
    temperature: float = 0.1
    max_retries: int = 2


class ExtractionResponse(BaseModel):
    """Response for extraction service test."""

    success: bool
    data: Dict[str, Any]
    service_used: str
    service_id: str
    message: str


@router.get("/services/list")
async def list_services(current_user: Optional[dict] = Depends(get_current_user)) -> ServiceRegistryResponse:
    """
    List all registered services in the service registry.

    This endpoint demonstrates service discovery without hard dependencies.

    Args:
        current_user: Authenticated user (optional for testing)

    Returns:
        List of registered services and capabilities
    """
    if not current_user:
        raise HTTPException(status_code=401, detail="Authentication required")

    service_registry = get_service_registry()
    services = service_registry.list_services()
    capabilities = service_registry.list_capabilities()

    return ServiceRegistryResponse(
        success=True,
        message=f"Found {len(services)} services providing {len(capabilities)} capabilities",
        data={
            "services": services,
            "capabilities": capabilities
        }
    )


@router.post("/services/test-extraction")
async def test_extraction_service(
    request: ExtractionRequest,
    current_user: Optional[dict] = Depends(get_current_user)
) -> ExtractionResponse:
    """
    Test consuming extraction services without hard dependencies.

    This endpoint demonstrates the service registry pattern by consuming
    extraction services without knowing which specific implementation is available.

    Args:
        request: Extraction parameters
        current_user: Authenticated user

    Returns:
        Extraction result with service information
    """
    if not current_user:
        raise HTTPException(status_code=401, detail="Authentication required")

    service_registry = get_service_registry()
    extraction_service = service_registry.get_extraction_service()

    if not extraction_service:
        return ExtractionResponse(
            success=False,
            data={},
            service_used="None",
            service_id="None",
            message="No extraction service available. Suggestions: Install KISSKI plugin, Install Grobid plugin, Ensure test plugin is properly initialized"
        )

    try:
        # Use the service (no knowledge of specific implementation)
        result = await extraction_service.extract(
            model=request.model,
            prompt=request.prompt,
            text_input=request.text_input or "Sample text for extraction testing",
            json_schema=request.json_schema,
            temperature=request.temperature,
            max_retries=request.max_retries
        )

        return ExtractionResponse(
            success=result["success"],
            data=dict(result),  # Convert ExtractionResult to dict
            service_used=extraction_service.service_name,
            service_id=extraction_service.service_id,
            message=f"Successfully used {extraction_service.service_name} service for extraction (no hard dependency!)"
        )

    except Exception as e:
        return ExtractionResponse(
            success=False,
            data={},
            service_used=extraction_service.service_name if extraction_service else "None",
            service_id=extraction_service.service_id if extraction_service else "None",
            message=f"Service consumption failed: {str(e)}"
        )


@router.get("/services/capabilities")
async def list_capabilities(current_user: Optional[dict] = Depends(get_current_user)) -> ServiceRegistryResponse:
    """
    List all available capabilities in the service registry.

    Args:
        current_user: Authenticated user (optional for testing)

    Returns:
        List of available capabilities
    """
    if not current_user:
        raise HTTPException(status_code=401, detail="Authentication required")

    service_registry = get_service_registry()
    capabilities = service_registry.list_capabilities()

    return ServiceRegistryResponse(
        success=True,
        message=f"Found {len(capabilities)} available capabilities",
        data={"capabilities": capabilities}
    )
