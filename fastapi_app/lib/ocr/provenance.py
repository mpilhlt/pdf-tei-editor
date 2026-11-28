"""
Where the text layer of a PDF comes from, for the documents extracted from it.

Text recognition and the LLM correction of the text layer store a record in the file metadata
of the PDF they create (`ocr`, `text_corrections`, see routers/ocr.py). An extraction from such a
PDF names them in its revision change and label, so that it is not taken for an extraction from
the original text layer.

Pure module.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

OCR_METADATA_KEY = "ocr"
"""Key of the text recognition record in the file metadata of a PDF."""

TEXT_CORRECTIONS_METADATA_KEY = "text_corrections"
"""Key of the list of text layer correction records in the file metadata of a PDF."""

OCR_LABEL_SUFFIX = "after OCR"
"""Added to the label of an extraction from a PDF whose text layer was made by text recognition."""


@dataclass(frozen=True)
class TextLayerProvenance:
    """How the text layer of a PDF was made: the label suffix and description of an extraction from it."""

    label_suffix: str
    description: str


def text_layer_provenance(file_metadata: Mapping[str, object]) -> TextLayerProvenance | None:
    """
    Describe the text recognition (and the LLM corrections after it) that made the text layer of a PDF.

    Args:
        file_metadata: The file metadata of the PDF

    Returns:
        None if the text layer was not made by text recognition
    """
    record = file_metadata.get(OCR_METADATA_KEY)
    if not isinstance(record, Mapping):
        return None
    engine = str(record.get("engine") or "unknown engine")
    languages = record.get("languages")
    language_text = f", languages: {', '.join(str(lang) for lang in languages)}" if isinstance(languages, list) and languages else ""
    applied_at = str(record.get("applied_at") or "")
    when = f" on {applied_at[:10]}" if applied_at else ""
    description = f"The text layer of the PDF was created by text recognition ({engine}{language_text}){when}."

    # LLM corrections of this text layer: those recorded after the text recognition
    models: list[str] = []
    count = 0
    corrections = file_metadata.get(TEXT_CORRECTIONS_METADATA_KEY)
    for correction in corrections if isinstance(corrections, list) else []:
        if not isinstance(correction, Mapping) or not correction.get("model_id") or str(correction.get("applied_at") or "") < applied_at:
            continue
        items = correction.get("corrections")
        count += len(items) if isinstance(items, list) else 0
        model = str(correction["model_id"])
        if model not in models:
            models.append(model)
    if models:
        description += f" {count} OCR error{'' if count == 1 else 's'} of it {'was' if count == 1 else 'were'} corrected by {', '.join(models)}."
    return TextLayerProvenance(label_suffix=OCR_LABEL_SUFFIX, description=description)


def pending_text_correction_pages(file_metadata: Mapping[str, object]) -> list[int]:
    """
    The pages (0-based, sorted) whose text corrections were written page by page into the PDF
    since the document was last updated for its PDF: the `pages` of the text-corrections records
    at the end of the list. These writes do not update the data of the extractor (such as GROBID's
    feature file) for the corrected PDF; the next write of the whole document does.

    Args:
        file_metadata: The file metadata of the PDF
    """
    records = file_metadata.get(TEXT_CORRECTIONS_METADATA_KEY)
    pages: set[int] = set()
    if not isinstance(records, list):
        return []
    for record in reversed(records):
        if not isinstance(record, Mapping) or not isinstance(record.get("pages"), list):
            break
        pages.update(p for p in record["pages"] if isinstance(p, int))
    return sorted(pages)
