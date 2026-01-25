"""
Custom routes for the test plugin.

This demonstrates how plugins can define their own API routes
beyond the generic /api/plugins/{id}/execute endpoint.
"""

from fastapi import APIRouter
from pydantic import BaseModel

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
