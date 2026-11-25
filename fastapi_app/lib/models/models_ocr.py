"""
Pydantic models for the OCR API.
"""

from typing import Literal, Optional

from pydantic import BaseModel, Field

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


class OcrRequest(BaseModel):
    """Request to apply OCR to a PDF."""

    stable_id: str = Field(..., min_length=1, description="stable_id of the PDF")
    engine: str = Field(..., min_length=1, description="Id of the OCR engine")
    languages: list[str] = Field(default_factory=list, description="Languages of the document as BCP 47 codes; the engine default if empty")
    options: dict[str, OcrOptionValue] = Field(default_factory=dict, description="Engine parameters")
    rebuild: bool = Field(False, description="The user explicitly asked to recreate the text layer: a digital text layer is replaced even if it looks fine")


class OcrResponse(BaseModel):
    """Result of an OCR run."""

    stable_id: str = Field(..., description="stable_id of the PDF (unchanged)")
    changed: bool = Field(..., description="Whether the PDF content changed")
    archived_stable_id: Optional[str] = Field(None, description="stable_id of the archived original PDF, if versions were made from it (they stay linked to it)")
    message: Optional[str] = Field(None, description="Message of the engine, if any")
    method: Optional[str] = Field(None, description="How the text layer was created ('skip', 'redo', 'force', 'vectorize'), if the engine reports it")
    fallback_reason: Optional[str] = Field(None, description="Why the engine fell back from the preferred method, if it did")
    quality: "TextQualityReport" = Field(..., description="Text layer quality after OCR")


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


OcrJobStatus = Literal["queued", "running", "done", "failed"]


class OcrProgress(BaseModel):
    """Progress of a running OCR job."""

    phase: str = Field(..., description="What the engine is doing, e.g. 'Recognizing text'")
    done: Optional[int] = Field(None, description="Units of the phase done so far, if the phase is counted")
    total: Optional[int] = Field(None, description="Units of the phase in total, if the phase is counted")
    unit: Optional[str] = Field(None, description="Unit of 'done' and 'total', e.g. 'page'")
    eta_seconds: Optional[int] = Field(None, description="Estimated seconds until the phase is finished, extrapolated from the units done so far")


class OcrJob(BaseModel):
    """
    An OCR run in the background. OCR of a long document can take longer than a reverse proxy
    waits for a response, so `POST /api/v1/ocr` returns the job at once and the client polls
    `GET /api/v1/ocr/jobs/{job_id}` until the status is 'done' or 'failed'. Only one OCR run
    happens at a time on the server; other jobs wait with the status 'queued'.
    """

    job_id: str = Field(..., description="Id of the job")
    stable_id: str = Field(..., description="stable_id of the PDF")
    status: OcrJobStatus = Field(..., description="'queued' (waiting for another run to finish), 'running', 'done' (see 'result') or 'failed' (see 'error')")
    progress: Optional[OcrProgress] = Field(None, description="Progress of the run if the status is 'running' and the engine reports it")
    result: Optional[OcrResponse] = Field(None, description="Result of the run if the status is 'done'")
    error: Optional[str] = Field(None, description="Error message if the status is 'failed'")
    error_status: Optional[int] = Field(None, description="HTTP status code corresponding to the error (4xx: invalid request, 5xx: failure of the engine or the server)")
    username: str = Field("", description="User who started the job")
    pid: int = Field(0, description="Id of the server process that runs the job")
    created_at: str = Field(..., description="ISO timestamp of the start of the job")
    updated_at: str = Field(..., description="ISO timestamp of the last status change")


OcrResponse.model_rebuild()
