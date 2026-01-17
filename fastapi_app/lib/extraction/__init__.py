"""
Extraction module for PDF-TEI Editor.

This module provides the extraction system for processing PDF and XML documents.
Extractors register themselves via the ExtractorRegistry during plugin initialization.
"""

from .base import BaseExtractor
from .llm_base import LLMBaseExtractor
from .registry import ExtractorRegistry
from .manager import (
    list_extractors,
    get_extractor,
    create_extractor,
    should_use_mock_extractor
)
from .http_utils import get_retry_session

__all__ = [
    'BaseExtractor',
    'LLMBaseExtractor',
    'ExtractorRegistry',
    'list_extractors',
    'get_extractor',
    'create_extractor',
    'should_use_mock_extractor',
    'get_retry_session'
]
