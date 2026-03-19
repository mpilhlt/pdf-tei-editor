from fastapi_app.plugins.tei_annotator.annotators.base import BaseAnnotator
from fastapi_app.plugins.tei_annotator.annotators.footnote import FootnoteAnnotator
from fastapi_app.plugins.tei_annotator.annotators.reference import ReferenceAnnotator

ANNOTATORS: list[BaseAnnotator] = [FootnoteAnnotator(), ReferenceAnnotator()]


def get_annotator(annotator_id: str) -> BaseAnnotator | None:
    """Return the annotator with *annotator_id*, or None if not found."""
    return next((a for a in ANNOTATORS if a.id == annotator_id), None)


__all__ = ["BaseAnnotator", "FootnoteAnnotator", "ReferenceAnnotator", "ANNOTATORS", "get_annotator"]
