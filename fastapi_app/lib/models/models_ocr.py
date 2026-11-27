"""
Pydantic models for the OCR API.
"""

from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator

from fastapi_app.lib.ocr.base import OcrOptionValue


class OcrOptionInfo(BaseModel):
    """Description of an OCR engine parameter."""

    type: Literal["string", "boolean", "integer"] = Field(..., description="Value type; a 'string' option with 'options' is a choice")
    label: Optional[str] = Field(None, description="Field label")
    description: Optional[str] = Field(None, description="Help text")
    options: Optional[list[str]] = Field(None, description="Allowed values of a 'string' option")
    default: Optional[OcrOptionValue] = Field(None, description="Default value")


class OcrEngineInfo(BaseModel):
    """Information about an available OCR engine."""

    id: str = Field(..., description="Unique identifier of the engine")
    name: str = Field(..., description="Human-readable name")
    description: str = Field("", description="Short description")
    languages: list[str] = Field(default_factory=list, description="Supported languages as normalized BCP 47 codes")
    default_languages: list[str] = Field(default_factory=list, description="Languages used when none are given")
    options: dict[str, OcrOptionInfo] = Field(default_factory=dict, description="Parameters apart from the languages")


class OcrLlmCorrectionRequest(BaseModel):
    """Request to correct the OCR errors of the text layer of a stored PDF with an LLM."""

    stable_id: str = Field(..., min_length=1, description="stable_id of the PDF")
    provider_id: str = Field(..., min_length=1, description="Id of the LLM provider")
    model_id: str = Field(..., min_length=1, description="Id of the model")
    languages: list[str] = Field(default_factory=list, description="Languages of the document as BCP 47 codes; if empty, those of the last OCR run of the PDF")


class OcrRequest(BaseModel):
    """Request to apply OCR to a PDF."""

    stable_id: str = Field(..., min_length=1, description="stable_id of the PDF")
    engine: str = Field(..., min_length=1, description="Id of the OCR engine")
    languages: list[str] = Field(default_factory=list, description="Languages of the document as BCP 47 codes; the engine default if empty")
    options: dict[str, OcrOptionValue] = Field(default_factory=dict, description="Engine parameters")
    rebuild: bool = Field(False, description="The user explicitly asked to recreate the text layer: a digital text layer is replaced even if it looks fine")
    llm_correction: bool = Field(False, description="Let an LLM correct OCR errors of the new text layer before the PDF is stored; requires provider_id and model_id")
    provider_id: Optional[str] = Field(None, min_length=1, description="Id of the LLM provider of the correction pass")
    model_id: Optional[str] = Field(None, min_length=1, description="Id of the model of the correction pass")

    @model_validator(mode="after")
    def _require_llm_ids(self) -> "OcrRequest":
        """The LLM correction pass needs a provider and a model."""
        if self.llm_correction and not (self.provider_id and self.model_id):
            raise ValueError("provider_id and model_id are required for the LLM correction")
        return self


class OcrLlmCorrection(BaseModel):
    """A correction of the text layer made by the LLM correction pass of an OCR run."""

    page: int = Field(..., description="Page index (0-based)")
    old: str = Field(..., description="Text of the text layer before the correction")
    new: str = Field(..., description="Corrected text")
    rationale: str = Field(..., description="Why the text is an OCR error")


class OcrResponse(BaseModel):
    """Result of an OCR run."""

    stable_id: str = Field(..., description="stable_id of the PDF that holds the result: a new PDF of the document if the content changed (#944), else the source")
    source_stable_id: str = Field(..., description="stable_id of the PDF the run started from; it is not changed")
    changed: bool = Field(..., description="Whether a new PDF was created")
    message: Optional[str] = Field(None, description="Message of the engine, if any")
    method: Optional[str] = Field(None, description="How the text layer was created ('skip', 'redo', 'force', 'vectorize'), if the engine reports it")
    fallback_reason: Optional[str] = Field(None, description="Why the engine fell back from the preferred method, if it did")
    quality: "TextQualityReport" = Field(..., description="Text layer quality after OCR")
    llm_corrections: list[OcrLlmCorrection] = Field(default_factory=list, description="Corrections made by the LLM correction pass, if it was requested")
    llm_correction_error: Optional[str] = Field(None, description="Why the LLM correction pass stopped or failed; the OCR result is kept")
    llm_correction_cancelled: bool = Field(False, description="Whether the user cancelled the LLM correction pass; the OCR result was stored before it started and is kept")


class TextCorrectionsRequest(BaseModel):
    """Request to preview or write the text corrections of a TEI document into the PDF's OCR text layer."""

    stable_id: str = Field(..., min_length=1, description="stable_id of the TEI document")
    skip_unwritable: bool = Field(False, description="Write the corrections even though some differences cannot be written (they are skipped)")
    progress_id: str | None = Field(None, description="Id of a progress widget of the client that shows the steps of the request (via SSE)")
    pages: list[int] | None = Field(None, description="Only the corrections on these pages (0-based page indices of the PDF, see OcrReviewPlanResponse.pages). Writing them updates the given version instead of creating a new one")


class TextCorrectionItem(BaseModel):
    """A word of the text layer that is replaced by the TEI's word."""

    page: int = Field(..., description="Page index (0-based)")
    line: int = Field(..., description="Index of the TEI line")
    old: str = Field(..., description="Word of the text layer")
    new: str = Field(..., description="Word of the TEI")


class UnwritableItem(BaseModel):
    """A difference between text layer and TEI that cannot be written into the layer."""

    page: int = Field(..., description="Page index (0-based)")
    line: Optional[int] = Field(None, description="Index of the TEI line, if the TEI has words there")
    layer_text: str = Field(..., description="Text of the text layer")
    tei_text: str = Field(..., description="Text of the TEI")
    reason: str = Field(..., description="Why the difference cannot be written")


class TextCorrectionsPreview(BaseModel):
    """What writing the text corrections would do, or why it is not possible."""

    corrections: list[TextCorrectionItem] = Field(default_factory=list, description="Corrections that would be written")
    unwritable: list[UnwritableItem] = Field(default_factory=list, description="Differences that cannot be written")
    reason: Optional[str] = Field(default=None, description="Why the corrections cannot be written; set means the action is not possible")
    update_pending: bool = Field(default=False, description="Corrections were written page by page without updating the document for the corrected PDF (the data of the extractor, such as GROBID's feature file). Writing the whole document does this, even if there are no corrections left")


class TextCorrectionsResult(BaseModel):
    """Result of writing the text corrections into the PDF."""

    xml: str = Field(..., description="The TEI document updated for the corrected PDF, as stored in the new version (or in the given version if only some pages were written)")
    tei_stable_id: str = Field(..., description="stable_id of the version that is attached to the corrected PDF: the new version, or the given one if only some pages were written")
    pdf_stable_id: str = Field(..., description="stable_id of the corrected PDF, a new PDF of the document (#944)")
    source_pdf_stable_id: str = Field(..., description="stable_id of the PDF the corrections were derived from; it is not changed")
    corrections: int = Field(..., description="Number of corrections written")
    new_version: bool = Field(default=True, description="False if the corrections of some pages were written into the given version, which is now attached to the corrected PDF; true if a new version was created")


TextQualityStatus = Literal["missing", "poor", "good"]


class TextQualityReport(BaseModel):
    """Assessment of the text layer of a PDF."""

    status: TextQualityStatus = Field(..., description="'missing': no usable text layer, 'poor': text layer of bad quality, 'good': no problems found")
    summary: str = Field(..., description="One-sentence description of the result")
    reasons: list[str] = Field(default_factory=list, description="Problems that were found")
    page_count: int = Field(0, description="Number of pages in the PDF")
    pages_analyzed: int = Field(0, description="Number of pages that were analyzed")
    pages_without_text: int = Field(0, description="Analyzed pages without a text layer")
    image_only_pages: int = Field(0, description="Analyzed pages that contain images but no text")
    ocr_layer_pages: int = Field(0, description="Analyzed pages with invisible text (an existing OCR layer)")
    char_count: int = Field(0, description="Number of non-whitespace characters found")
    garbled_char_ratio: float = Field(0.0, description="Share of characters that are replacement, control, private-use or unmapped glyph characters")
    plausible_word_ratio: Optional[float] = Field(None, description="Share of tokens that look like words or numbers")
    language: Optional[str] = Field(None, description="Language detected in the text layer")
    language_confidence: Optional[float] = Field(None, description="Confidence of the language detection (0-1)")
    layout_checked: bool = Field(default=False, description="Whether the text layer was compared with the words recognized on sample page images")
    layout_text_match: Optional[float] = Field(default=None, description="Share of words recognized on the page images that match the text layer (0-1)")
    layout_position_match: Optional[float] = Field(default=None, description="Share of matching words that are at the same place in the text layer (0-1)")
    layout_order_agreement: Optional[float] = Field(default=None, description="Share of matching words that are in the same order in the text layer (0-1)")
    ocr_applied: Optional[dict[str, str | list[str]]] = Field(default=None, description="Record of a previous OCR run by this application")


class OcrReviewPlanRequest(BaseModel):
    """Request for the number of page windows of the LLM review of OCR errors."""

    stable_id: str = Field(..., min_length=1, description="stable_id of the TEI document (zone document with a line layout)")
    xml: str = Field(..., description="Current, possibly unsaved XML content of the document")
    scope: Optional[str] = Field(None, description="Raw XML of a node of `xml` to review instead of the whole text")


class OcrReviewPlanResponse(BaseModel):
    """The number of page windows the review needs."""

    window_count: int = Field(..., description="Number of windows; request each `window_index` below it in turn")
    pages: list[int] = Field(default_factory=list, description="The pages of the windows (0-based page indices of the PDF); with a scope, the pages the node lies on")


class OcrReviewRequest(BaseModel):
    """Request to review one page window of a TEI document for OCR errors with an LLM."""

    stable_id: str = Field(..., min_length=1, description="stable_id of the TEI document (zone document with a line layout)")
    xml: str = Field(..., description="Current, possibly unsaved XML content of the document")
    provider_id: str = Field(..., min_length=1, description="Id of the LLM provider")
    model_id: str = Field(..., min_length=1, description="Id of the model")
    window_index: int = Field(0, description="Index of the page window to review (0-based)")
    scope: Optional[str] = Field(None, description="Raw XML of a node of `xml` to review instead of the whole text")


class OcrReviewFinding(BaseModel):
    """A proposed correction: replace `old` (unique in the XML) by `new`."""

    id: int = Field(..., description="Id of the finding, unique within its window")
    old: str = Field(..., description="Exact text of the XML to replace")
    new: str = Field(..., description="Replacement")
    rationale: str = Field(..., description="Why the text is an OCR error")


class OcrReviewResponse(BaseModel):
    """The findings of one page window."""

    findings: list[OcrReviewFinding] = Field(..., description="Proposed corrections")
    window_count: int = Field(..., description="Number of windows of the document")
    discarded: int = Field(0, description="Proposals of the model that were dropped as implausible or not applicable")
    window_start: Optional[int] = Field(None, description="Start of the window's text in `xml` (UTF-16 code units)")
    window_end: Optional[int] = Field(None, description="End of the window's text in `xml` (UTF-16 code units)")


OcrResponse.model_rebuild()
