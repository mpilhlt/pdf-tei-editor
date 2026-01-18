"""GROBID plugin configuration."""

# Supported training data variants
# These correspond to GROBID training model types
SUPPORTED_VARIANTS = [
    "grobid.training.segmentation",
    "grobid.training.references.referenceSegmenter",
    "grobid.training.references",
]


def get_supported_variants() -> list[str]:
    """Return list of supported GROBID training variants."""
    return SUPPORTED_VARIANTS.copy()
