"""Mapping from variant ID to TEI element paths in GROBID output and stored documents."""

from typing import TypedDict


class ContentLocation(TypedDict):
    """XPath-like paths locating training content within a TEI document."""

    grobid_path: str     # element path in raw GROBID output (relative to root TEI element)
    annotation_path: str  # element path in stored document (relative to root TEI element)


VariantContentLocations = dict[str, ContentLocation]

# Variants not listed here use the default: content is in <text> in both contexts.
VARIANT_CONTENT_LOCATIONS: VariantContentLocations = {
    "grobid.training.header.affiliation": {
        "grobid_path": "teiHeader",
        "annotation_path": "text/front",
    },
    "grobid.training.header.authors": {
        "grobid_path": "teiHeader",
        "annotation_path": "text/front",
    },
    "grobid.training.header.date": {
        "grobid_path": "teiHeader",
        "annotation_path": "text/front",
    },
}
