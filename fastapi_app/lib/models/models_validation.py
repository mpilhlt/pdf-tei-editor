"""
Pydantic models for XML/TEI validation APIs.

For FastAPI migration - Phase 5.
"""

from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field


class ValidateRequest(BaseModel):
    """Request to validate XML against embedded schema references."""
    xml_string: str = Field(
        ...,
        description="XML document to validate",
        min_length=1
    )


class ValidationErrorModel(BaseModel):
    """A single validation error or warning."""
    message: str = Field(
        ...,
        description="Error or warning message"
    )
    line: int = Field(
        ...,
        description="Line number where error occurred",
        ge=1
    )
    column: int = Field(
        ...,
        description="Column number where error occurred",
        ge=0
    )
    severity: Optional[str] = Field(
        None,
        description="Error severity (e.g., 'warning' for timeout messages)"
    )


class ValidateResponse(BaseModel):
    """Response from XML validation."""
    errors: List[ValidationErrorModel] = Field(
        default_factory=list,
        description="List of validation errors/warnings. Empty if validation passed."
    )


class AutocompleteDataRequest(BaseModel):
    """Request to generate CodeMirror autocomplete data from schema."""
    xml_string: str = Field(
        ...,
        description="XML document containing schema reference",
        min_length=1
    )
    invalidate_cache: bool = Field(
        False,
        description="Whether to invalidate cache and re-download schema"
    )


class AutocompleteDataResponse(BaseModel):
    """
    Response containing CodeMirror autocomplete data.

    The structure is a nested dictionary where:
    - Top-level keys are element names
    - Each element has optional 'children', 'attrs', and 'doc' properties
    - 'children' is a list of allowed child element names
    - 'attrs' is a dict of attribute names to possible values (list or null)
    - 'doc' is optional documentation string

    When deduplicate=True, may include reference keys starting with '#'.
    """
    # Using Dict[str, Any] for flexibility since the structure is complex and nested
    data: Dict[str, Any] = Field(
        ...,
        description="CodeMirror autocomplete map with element definitions"
    )

    class Config:
        json_schema_extra = {
            "example": {
                "data": {
                    "title": {
                        "attrs": {
                            "xml:lang": None,
                            "type": ["main", "sub", "desc"]
                        },
                        "children": ["ref", "note"],
                        "doc": "Title of the document"
                    },
                    "ref": {
                        "attrs": {
                            "target": None
                        }
                    }
                }
            }
        }
