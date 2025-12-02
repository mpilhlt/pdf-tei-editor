"""
Extractor discovery and management for FastAPI.

This module wraps the existing server.extractors.discovery module which is already
framework-agnostic and can be shared between Flask and FastAPI implementations.

For FastAPI migration - Phase 5.
"""

from typing import List, Dict, Any
from fastapi_app.extractors.discovery import (
    list_extractors as _list_extractors,
    create_extractor as _create_extractor,
    get_extractor as _get_extractor
)
from fastapi_app.extractors import BaseExtractor

# Re-export types
__all__ = ['list_extractors', 'create_extractor', 'get_extractor', 'BaseExtractor']


def list_extractors(
    input_filter: List[str] = None,
    output_filter: List[str] = None,
    available_only: bool = True
) -> List[Dict[str, Any]]:
    """
    List available extractors with optional filtering.

    Args:
        input_filter: Only include extractors that support these input types
        output_filter: Only include extractors that support these output types
        available_only: Only include extractors that are currently available

    Returns:
        List of extractor info dictionaries with keys:
        - id: Extractor identifier
        - name: Human-readable name
        - description: Description of the extractor
        - input: List of supported input types (e.g., ["pdf"], ["xml"])
        - output: List of supported output types (e.g., ["xml"])
        - available: Whether the extractor is currently available
    """
    return _list_extractors(
        input_filter=input_filter,
        output_filter=output_filter,
        available_only=available_only
    )


def create_extractor(extractor_id: str) -> BaseExtractor:
    """
    Create an instance of an extractor.

    Args:
        extractor_id: The ID of the extractor to create

    Returns:
        An instance of the extractor

    Raises:
        KeyError: If extractor is not found
        RuntimeError: If extractor is not available (missing dependencies)
    """
    return _create_extractor(extractor_id)


def get_extractor(extractor_id: str):
    """
    Get an extractor class by ID.

    Args:
        extractor_id: The ID of the extractor

    Returns:
        The extractor class

    Raises:
        KeyError: If extractor is not found
        RuntimeError: If extractor is not available
    """
    return _get_extractor(extractor_id)


def should_use_mock_extractor(extractor_id: str, error_message: str) -> bool:
    """
    Determine if we should fall back to mock extractor for the given error.

    This is useful when external dependencies are missing but we want to continue
    with mock data for development/testing.

    Args:
        extractor_id: The ID of the extractor that failed
        error_message: The error message from the failed extractor

    Returns:
        True if we should use mock extractor, False otherwise
    """
    import os

    # Use mock extractor when external dependencies are missing
    mock_conditions = [
        "GROBID_SERVER_URL" in error_message,
        "GEMINI_API_KEY" in error_message,
        "not available" in error_message.lower(),
        "dependencies" in error_message.lower()
    ]

    # Check environment variables for explicit mock mode
    use_mock_extractors = os.environ.get("USE_MOCK_EXTRACTORS", "").lower() in ["true", "1", "yes"]

    return use_mock_extractors or any(mock_conditions)
