"""
Pydantic models for metadata extraction APIs.

For FastAPI migration - Phase 5.
"""

from typing import List, Optional, Dict, Any
from pydantic import BaseModel, ConfigDict, Field

from .models_ocr import OcrRequest, OcrResponse


class AnnotationGuideInfo(BaseModel):
    """Information about an annotation guide for one or more variants."""
    variant_ids: List[str] = Field(
        ...,
        description="The variant identifier(s) this guide applies to; \"*\" means every variant"
    )
    category: Optional[str] = Field(
        None,
        description="The rule category this guide belongs to (e.g. \"primary\"); "
                    "not every extractor plugin populates this"
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
    """An attribute editable in the post-hoc properties popup for an
    already-tagged element (enumerated or freeform)."""
    name: str = Field(..., description="XML attribute name")
    values: Optional[List[str]] = Field(
        None,
        description="Allowed values; if None, a free-text input is shown"
    )
    required: bool = Field(
        True,
        description="Whether this attribute must always be present; if False, the "
                     "properties popup offers a way to clear it once set"
    )


class AnnotationTagVariant(BaseModel):
    """One split-button dropdown entry: an attribute-value combination
    (one or more attributes assigned together) applied when wrapping a
    selection or retagging an element."""
    attrs: Dict[str, str] = Field(
        ..., description="Attribute name/value pairs applied when this variant is chosen"
    )
    description: Optional[str] = Field(
        None, description="Tooltip text for this specific variant"
    )


class AnnotationTagDef(BaseModel):
    """Definition of an annotation tag contributed by a variant plugin."""
    tag: str = Field(..., description="XML element name (e.g. 'bibl')")
    label: str = Field(..., description="Chip label; always the bare tag name")
    color: str = Field(..., description="CSS colour for this tag's badge and underline")
    attributes: List[AnnotationTagAttribute] = Field(
        default_factory=list,
        description="Attributes shown in the properties popup for an already-tagged element"
    )
    variants: List[AnnotationTagVariant] = Field(
        default_factory=list,
        description="Attribute-value dropdown options for the split-button chip; empty if the tag has no enumerated attributes"
    )
    bareAllowed: bool = Field(
        True,
        description="Whether clicking the chip body (as opposed to only the dropdown) inserts the bare tag with no attributes"
    )
    description: Optional[str] = Field(
        None,
        description="Tooltip text for the chip itself"
    )
    childTags: List[str] = Field(
        default_factory=list,
        description="Tag names that may be nested inside this element rather than splitting it"
    )
    empty: bool = Field(
        False,
        description="Element without content (e.g. gap, pb): shown as a clickable badge for its attributes, but not offered in the palette for wrapping text"
    )
    readOnly: bool = Field(
        False,
        description="Display-only element (e.g. text): shown as a badge, but not editable, not offered in the palette and without coloring of its content, so that its children are displayed as top-level elements"
    )


class ZoneLabelDef(BaseModel):
    """A zone label of a zone document: its short code and the element it stands for."""
    code: str = Field(..., description="Short code shown to models and in the unit review, e.g. 'note:headnote'")
    element: str = Field(..., description="Element name of the zone, e.g. 'note'")
    attributes: Dict[str, str] = Field(default_factory=dict, description="Attributes of the zone element, e.g. {'place': 'headnote'}")


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
    uses_inference_model: bool = Field(
        False,
        description="Whether the extractor runs on the LLM model chosen under Tools > Default Model; the client then sends it as the provider_id/model_id options"
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
    annotationTags: Dict[str, List[AnnotationTagDef]] = Field(
        default_factory=dict,
        description="Annotation tag definitions keyed by variant_id"
    )
    annotationTagsCutoff: Dict[str, int] = Field(
        default_factory=dict,
        description="Per-variant count of top-level menu items; tags beyond this go in 'More...' submenu"
    )
    reviewUnits: Dict[str, str] = Field(
        default_factory=dict,
        description="Per-variant path of the review units below TEI/text for unit review mode (e.g. './/listBibl/bibl'), keyed by variant_id; 'auto' or a missing entry uses the automatic heuristic, 'pages' the pages of a zone document (see zoneLabels)"
    )
    zoneLabels: Dict[str, List[ZoneLabelDef]] = Field(
        default_factory=dict,
        description="Per-variant zone labels of zone documents, whose <text> children are zones that partition the text (see fastapi_app/lib/tei/zone_lines.py), keyed by variant_id"
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


class ExtractorCheckRequest(BaseModel):
    """Request to check whether an extractor can run now."""
    extractor: str = Field(..., description="ID of the extractor", min_length=1)
    options: Dict[str, Any] = Field(default_factory=dict, description="The extraction options that will be used")


class ExtractorCheckResponse(BaseModel):
    """Whether an extractor can run now."""
    ready: bool = Field(..., description="Whether the extractor can run now")
    message: Optional[str] = Field(None, description="Why the extractor cannot run, if it is not ready")


class LanguageConflict(BaseModel):
    """The language declared in an extraction result contradicts the language of the document's text."""
    declared: str = Field(..., description="Language declared in teiHeader/profileDesc/langUsage, e.g. taken from CrossRef")
    detected: str = Field(..., description="Language detected with high confidence from the text of the document")


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
    language_conflict: Optional[LanguageConflict] = Field(
        None,
        description="Set if the declared language contradicts the detected one; the client asks the user whether to declare the detected language"
    )

    model_config = ConfigDict(json_schema_extra={
        "example": {
            "id": "example_doc",
            "pdf": "abc123def456",
            "xml": "789ghi012jkl"
        }
    })


class ExtractJobRequest(ExtractRequest):
    """Request of `POST /api/v1/extract/job`: an extraction run as a job, with text recognition as its optional first step."""
    ocr: Optional[OcrRequest] = Field(
        default=None,
        description="If set and the extractor extracts from the PDF, text recognition is applied to the PDF (`stable_id` must be the PDF of `file_id`) before the extraction, which then extracts from the new PDF"
    )


class ExtractJobResult(ExtractResponse):
    """Result of a job of type `extract`: the `ExtractResponse`, and the result of the text recognition if it ran."""
    xml: Optional[str] = Field(
        default=None,
        description="Extracted XML file (stable_id); None if nothing was extracted because the job was cancelled after the text recognition result was stored"
    )
    ocr: Optional[OcrResponse] = Field(
        default=None,
        description="Result of the text recognition, if the job ran it"
    )
    cancelled: bool = Field(
        default=False,
        description="The job was cancelled after the text recognition result was stored (also during its LLM correction pass): the new PDF is kept, nothing was extracted"
    )
