"""GROBID plugin configuration."""

from fastapi_app.lib.config_utils import get_config


def get_grobid_server_url() -> str | None:
    """
    Get the GROBID server URL from config.

    The config value is initialized from the GROBID_SERVER_URL environment
    variable by the plugin's is_available() method.

    Returns:
        The GROBID server URL, or None if not configured.
    """
    config = get_config()
    url = config.get("grobid.server.url")
    return url if url else None


# Supported variants - training data and service endpoints
SUPPORTED_VARIANTS = [
    # Training variants (use /api/createTraining endpoint)
    "grobid.training.segmentation",
    "grobid.training.references.referenceSegmenter",
    "grobid.training.references",
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
            "value": "//tei:bibl",
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
        "variant_id": "grobid.training.references",
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


def get_annotation_guides() -> list[dict]:
    """Return list of annotation guide configurations."""
    return ANNOTATION_GUIDES.copy()
