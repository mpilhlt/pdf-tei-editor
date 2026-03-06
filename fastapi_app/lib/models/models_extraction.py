"""
Pydantic models for metadata extraction APIs.

For FastAPI migration - Phase 5.
"""

from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field


class AnnotationGuideInfo(BaseModel):
    """Information about an annotation guide for a variant."""
    variant_id: str = Field(
        ...,
        description="The variant identifier this guide applies to"
    )
    type: str = Field(
        ...,
        description="The content type: 'html' or 'markdown'"
    )
    url: str = Field(
        ...,
        description="The URL to fetch the guide from"
    )


class ExtractorInfo(BaseModel):
    """Information about an available extractor."""
    id: str = Field(
        ...,
        description="Unique identifier for the extractor"
    )
    name: str = Field(
        ...,
        description="Human-readable name of the extractor"
    )
    description: str = Field(
        ...,
        description="Description of what the extractor does"
    )
    input: List[str] = Field(
        ...,
        description="Supported input types (e.g., ['pdf'], ['xml'])"
    )
    output: List[str] = Field(
        ...,
        description="Supported output types (e.g., ['xml'])"
    )
    available: bool = Field(
        ...,
        description="Whether the extractor is currently available"
    )
    options: Optional[Dict[str, Any]] = Field(
        None,
        description="Configuration options supported by the extractor"
    )
    navigation_xpath: Optional[Dict[str, Any]] = Field(
        None,
        description="XPath expressions for navigation, keyed by variant_id"
    )
    annotationGuides: Optional[List[AnnotationGuideInfo]] = Field(
        None,
        description="Annotation guide URLs for each variant"
    )


class ListExtractorsResponse(BaseModel):
    """Response from list extractors endpoint."""
    extractors: List[ExtractorInfo] = Field(
        default_factory=list,
        description="List of available extractors"
    )


class ExtractRequest(BaseModel):
    """Request to perform metadata extraction."""
    extractor: str = Field(
        ...,
        description="ID of the extractor to use",
        min_length=1
    )
    file_id: str = Field(
        ...,
        description="File identifier (hash, stable ID, or upload filename)",
        min_length=1
    )
    options: Dict[str, Any] = Field(
        default_factory=dict,
        description="Extractor-specific options (e.g., doi, collection, variant_id)"
    )

    class Config:
        json_schema_extra = {
            "example": {
                "extractor": "grobid",
                "file_id": "abc123def456",
                "options": {
                    "doi": "10.1234/example",
                    "collection": "my_corpus",
                    "variant_id": "grobid"
                }
            }
        }


class ExtractResponse(BaseModel):
    """Response from extraction endpoint."""
    id: Optional[str] = Field(
        None,
        description="Document ID (for PDF-based extractions)"
    )
    pdf: Optional[str] = Field(
        None,
        description="PDF file hash (if applicable)"
    )
    xml: str = Field(
        ...,
        description="Extracted/generated XML file hash"
    )

    class Config:
        json_schema_extra = {
            "example": {
                "id": "example_doc",
                "pdf": "abc123def456",
                "xml": "789ghi012jkl"
            }
        }
