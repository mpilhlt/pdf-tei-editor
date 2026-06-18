"""Annotation guide URLs for each GROBID variant."""

from typing import Literal, TypedDict


class AnnotationGuide(TypedDict):
    """A link to an annotation guide for a specific variant."""

    variant_id: str
    type: Literal["markdown", "html"]
    url: str


ANNOTATION_GUIDES: list[AnnotationGuide] = [
    {
        "variant_id": "grobid.training.segmentation",
        "type": "markdown",
        "url": "https://pad.gwdg.de/s/1Oti-hJDb/download#segmentation",
    },
    {
        "variant_id": "grobid.training.segmentation",
        "type": "markdown",
        "url": "https://pad.gwdg.de/s/1Oti-hJDb#segmentation",
    },
    {
        "variant_id": "grobid.training.references.referenceSegmenter",
        "type": "markdown",
        "url": "https://pad.gwdg.de/s/1Oti-hJDb/download#reference-segmenter",
    },
    {
        "variant_id": "grobid.training.references",
        "type": "html",
        "url": "https://grobid.readthedocs.io/en/latest/training/Bibliographical-references",
    },
]
