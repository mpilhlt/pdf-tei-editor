"""GROBID plugin configuration."""

from fastapi_app.lib.utils.config_utils import get_config


SCHEMA_BASE_URL = "https://mpilhlt.github.io/grobid-footnote-flavour/schema"


def get_schema_url(variant_id: str) -> str:
    """Get RNG schema URL for a GROBID variant."""
    return f"{SCHEMA_BASE_URL}/{variant_id}.rng"


def get_grobid_server_timeout() -> int:
    """
    Get the GROBID server health-check timeout in seconds from config.

    The config value is initialized from the GROBID_SERVER_TIMEOUT environment
    variable by the plugin's __init__() method.

    Returns:
        Timeout in seconds (default: 10).
    """
    config = get_config()
    value = config.get("plugin.grobid.server.timeout", default=10)
    return int(value)


def get_grobid_extraction_timeout() -> int:
    """
    Get the GROBID extraction request timeout in seconds from config.

    The config value is initialized from the GROBID_EXTRACTION_TIMEOUT environment
    variable by the plugin's __init__() method.

    Returns:
        Timeout in seconds (default: 300).
    """
    config = get_config()
    value = config.get("plugin.grobid.extraction.timeout", default=300)
    return int(value)


def get_grobid_server_url() -> str | None:
    """
    Get the GROBID server URL from config.

    The config value is initialized from the GROBID_SERVER_URL environment
    variable by the plugin's is_available() method.

    Returns:
        The GROBID server URL, or None if not configured.
    """
    config = get_config()
    url = config.get("plugin.grobid.server.url")
    return url if url else None


# Mapping from training variant ID to GROBID model path
VARIANT_MODEL_PATHS: dict[str, str] = {
    "grobid.training.header.affiliation": "affiliation-address",
    "grobid.training.header.authors": "name/header",
    "grobid.training.header.date": "date",
    "grobid.training.header": "header",
    "grobid.training.segmentation": "segmentation",
    "grobid.training.references": "citation",
    "grobid.training.references.authors": "name/citation",
    "grobid.training.references.referenceSegmenter": "reference-segmenter",
    "grobid.training.table": "table",
    "grobid.training.figure": "figure",
}

# Supported variants - training data and service endpoints
SUPPORTED_VARIANTS = [
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

# Processing flavors
PROCESSING_FLAVORS = [
    "default",
    "article/dh-law-footnotes"
]

# Form options for the extraction dialog
FORM_OPTIONS = {
    "doi": {
        "type": "string",
        "label": "DOI",
        "description": "DOI of the document for metadata enrichment",
        "required": False
    },
    "variant_id": {
        "type": "string",
        "label": "Variant identifier",
        "description": "Variant identifier for the training data type",
        "required": False,
        "options": SUPPORTED_VARIANTS
    },
    "flavor": {
        "type": "string",
        "label": "GROBID processing flavor",
        "description": "Processing flavor that determines how GROBID analyzes the document structure",
        "required": False,
        "options": PROCESSING_FLAVORS
    }
}

# Navigation XPath expressions for each variant
NAVIGATION_XPATH = {
    "grobid.training.segmentation": [
        {
            "value": "//tei:listBibl",
            "label": "&lt;listBibl&gt;"
        }
    ],
    "grobid.training.references.referenceSegmenter": [
        {
            "value": "//tei:listBibl/tei:bibl",
            "label": "&lt;bibl&gt;"
        }
    ],
    "grobid.training.references": [
        {
            "value": "//tei:bibl",
            "label": "&lt;bibl&gt;"
        }
    ],
    "grobid.service.fulltext": [
        {
            "value": "//tei:div",
            "label": "&lt;div&gt;"
        },
        {
            "value": "//tei:bibl",
            "label": "&lt;bibl&gt;"
        }
    ],
    "grobid.service.references": [
        {
            "value": "//tei:bibl",
            "label": "&lt;bibl&gt;"
        }
    ]
}

# Annotation guide URLs for each variant
# Each entry contains variant_id, type (markdown/html), and URL
ANNOTATION_GUIDES = [
    {
        "variant_id": "grobid.training.segmentation",
        "type": "markdown",
        "url": "https://pad.gwdg.de/s/1Oti-hJDb/download#segmentation"
    },
    {
        "variant_id": "grobid.training.segmentation",
        "type": "html",
        "url": "https://pad.gwdg.de/s/1Oti-hJDb#segmentation"
    },
    {
        "variant_id": "grobid.training.references.referenceSegmenter",
        "type": "markdown",
        "url": "https://pad.gwdg.de/s/1Oti-hJDb/download#reference-segmenter"
    },
    {
        "variant_id": "grobid.training.references",
        "type": "html",
        "url": "https://pad.gwdg.de/s/1Oti-hJDb#reference-segmenter"
    }
]


def get_supported_variants() -> list[str]:
    """Return list of supported GROBID training variants."""
    return SUPPORTED_VARIANTS.copy()


def get_processing_flavors() -> list[str]:
    """Return list of processing flavors."""
    return PROCESSING_FLAVORS.copy()


def get_form_options() -> dict:
    """Return form options for the extraction dialog."""
    import copy
    return copy.deepcopy(FORM_OPTIONS)


def get_navigation_xpath() -> dict:
    """Return navigation XPath expressions for each variant."""
    import copy
    return copy.deepcopy(NAVIGATION_XPATH)


def get_model_path(variant_id: str) -> str:
    """Return the GROBID model path for a training variant ID."""
    if variant_id in VARIANT_MODEL_PATHS:
        return VARIANT_MODEL_PATHS[variant_id]
    # Fallback: strip prefix and replace dots with slashes
    return variant_id.removeprefix("grobid.training.").replace(".", "/")


def get_annotation_guides() -> list[dict]:
    """Return list of annotation guide configurations."""
    return ANNOTATION_GUIDES.copy()
