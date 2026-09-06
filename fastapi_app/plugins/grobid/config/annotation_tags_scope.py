"""
Per-variant scope for schema-driven annotation tag generation: which
element is the "root" whose content-model children become chips, and
which of those children are excluded (never meaningfully "annotated" via
the chip popup, e.g. a bare line break).

Unlike the annotation tag data itself (generated from the schema), this
config only changes if a variant's overall document shape changes, which
is rare — see docs/superpowers/specs/2026-09-05-annotation-chip-schema-redesign-design.md.
"""

from typing import TypedDict


class TagScope(TypedDict):
    root: str
    exclude: set[str]


ANNOTATION_TAG_SCOPE: dict[str, TagScope] = {
    "grobid.training.segmentation": {
        "root": "text",
        "exclude": {"lb"},
    },
    "grobid.training.references.referenceSegmenter": {
        "root": "bibl",
        "exclude": {"lb"},
    },
    "grobid.training.references": {
        "root": "bibl",
        "exclude": {"lb"},
    },
}
