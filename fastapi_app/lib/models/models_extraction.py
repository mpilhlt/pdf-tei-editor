"""
Pydantic models for metadata extraction APIs.

For FastAPI migration - Phase 5.
"""

from typing import List, Optional, Dict, Any
from pydantic import BaseModel, ConfigDict, Field


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


class AnnotationTagAttribute(BaseModel):
    """A single XML attribute that can be edited in the annotation properties popup."""
    name: str = Field(..., description="XML attribute name")
    values: Optional[List[str]] = Field(
        None,
        description="Allowed values; if None, a free-text input is shown"
    )


class AnnotationTagDef(BaseModel):
    """Definition of an annotation tag contributed by a variant plugin."""
    tag: str = Field(..., description="XML element name (e.g. 'bibl')")
    label: str = Field(
        ...,
        description="Badge label; may contain {@attrName} template tokens"
    )
    labelMap: Optional[Dict[str, str]] = Field(
        None,
        description="Attribute-value → label overrides, e.g. {'level=m': 'TITLE[M]'}"
    )
    color: str = Field(..., description="CSS colour for this tag's badge and underline")
    attributes: List[AnnotationTagAttribute] = Field(
        default_factory=list,
        description="Attributes shown in the properties popup"
    )
    description: Optional[str] = Field(
        None,
        description="Tooltip text for the context menu item"
    )
    priority: int = Field(
        100,
        description="Sort order; lower = shown first in the menu"
    )
    defaultAttributes: Optional[Dict[str, str]] = Field(
        None,
        description="Attribute key/value pairs baked into the opening tag when wrapping a selection"
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
    variants: Optional[List[str]] = Field(
        None,
        description="List of supported variant identifiers"
    )
    navigation_xpath: Optional[Dict[str, Any]] = Field(
        None,
        description="XPath expressions for navigation, keyed by variant_id"
    )
    annotationGuides: Optional[List[AnnotationGuideInfo]] = Field(
        None,
        description="Annotation guide URLs for each variant"
    )
    annotationTags: List[AnnotationTagDef] = Field(
        default_factory=list,
        description="Annotation tag definitions for this extractor's variants"
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

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "extractor": "grobid",
            "file_id": "abc123def456",
            "options": {
                "doi": "10.1234/example",
                "collection": "my_corpus",
                "variant_id": "grobid"
            }
        }
    })


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

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "id": "example_doc",
            "pdf": "abc123def456",
            "xml": "789ghi012jkl"
        }
    })
