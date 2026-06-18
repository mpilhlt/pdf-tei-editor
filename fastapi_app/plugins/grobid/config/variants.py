"""Supported GROBID variant and flavor lists."""

SUPPORTED_VARIANTS: list[str] = [
    # Training variants (use /api/createTraining endpoint)
    "grobid.training.header.affiliation",
    "grobid.training.header.authors",
    "grobid.training.header.date",
    "grobid.training.header",
    "grobid.training.segmentation",
    "grobid.training.references",
    "grobid.training.references.authors",
    "grobid.training.references.referenceSegmenter",
    "grobid.training.table",
    "grobid.training.figure",

    # Service variants (use direct API endpoints)
    "grobid.service.fulltext",
    "grobid.service.references",
]

PROCESSING_FLAVORS: list[str] = [
    "default",
    "article/dh-law-footnotes",
]
