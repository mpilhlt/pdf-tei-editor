"""Annotation guide URLs for GROBID variants.

Each entry names the variant(s) it applies to (`variant_ids`; the literal
"*" is planned to mean "every variant", once the matching logic supports it)
and the rule category it belongs to ("primary" is the sentinel for the
per-variant main section a human annotator should read; other categories are
optional, machine-only excerpts for LLM validation). URLs are branch-relative
GitHub blob links; they get permalink-pinned to a commit SHA when embedded
into a document's editorialDecl, and a heading-anchor URL will additionally
be used to auto-derive a machine-targeted (line-range) sibling ref, once
implemented - see fastapi_app/plugins/grobid/annotation_rules.py and
docs/superpowers/specs/2026-09-22-annotation-guide-dual-target-refs-design.md.
"""

from typing import Literal, TypedDict


class AnnotationGuide(TypedDict):
    """A link to an annotation guide for one or more variants and a rule category."""

    variant_ids: list[str]
    category: str
    type: Literal["markdown", "html"]
    url: str


ANNOTATION_GUIDES: list[AnnotationGuide] = [
    {
        "variant_ids": ["grobid.training.segmentation"],
        "category": "primary",
        "type": "markdown",
        "url": "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#document-segmentation-model",
    },
    {
        "variant_ids": ["grobid.training.references.referenceSegmenter"],
        "category": "primary",
        "type": "markdown",
        "url": "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#reference-segmentation-model",
    },
    {
        "variant_ids": ["grobid.training.references"],
        "category": "primary",
        "type": "markdown",
        "url": "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#citation-model",
    },
    {
        "variant_ids": ["*"],
        "category": "data-correction",
        "type": "markdown",
        "url": "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#data-correction",
    },
]
