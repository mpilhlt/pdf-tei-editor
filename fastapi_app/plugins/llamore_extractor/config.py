"""LLamore plugin configuration."""

from typing import Any

from fastapi_app.lib.plugins.plugin_tools import get_plugin_config

PLUGIN_CONFIG_SPECS: list[dict[str, Any]] = [
    {
        "config_key": "plugin.llamore.api.key",
        "env_var":    "GEMINI_API_KEY",
        "default":     None,
        "description": "Gemini API key for LLamore extraction",
    },
    {
        "config_key": "plugin.llamore.model",
        "env_var":    "LLAMORE_MODEL",
        "default":     "gemini-2.0-flash",
        "description": "Gemini model identifier used by LLamore for reference extraction",
    },
]


def init_plugin_config() -> None:
    """Register plugin config keys from environment variables."""
    for spec in PLUGIN_CONFIG_SPECS:
        get_plugin_config(**spec)


SCHEMA_BASE_URL = "https://mpilhlt.github.io/llamore/schema"


def get_schema_url(variant_id: str = "llamore-default") -> str:
    """Get RNG schema URL for a LLamore variant."""
    return f"{SCHEMA_BASE_URL}/{variant_id}.rng"


# Supported variants
SUPPORTED_VARIANTS = [
    "llamore-default",
]

# Form options for the extraction dialog
FORM_OPTIONS = {
    "doi": {
        "type": "string",
        "label": "DOI",
        "description": "DOI of the document for metadata enrichment",
        "required": False
    },
    "instructions": {
        "type": "string",
        "label": "Instructions",
        "description": "Additional instructions for the extraction process",
        "required": False
    },
    "variant_id": {
        "type": "string",
        "label": "Variant identifier",
        "description": "Variant identifier for the LLamore extraction",
        "required": False,
        "options": SUPPORTED_VARIANTS
    }
}

# Navigation XPath expressions for each variant
NAVIGATION_XPATH = {
    "llamore-default": [
        {
            "value": "//tei:biblStruct",
            "label": "&lt;biblStruct&gt;"
        }
    ]
}

# Annotation guide URLs for each variant
ANNOTATION_GUIDES = [
    {
        "variant_id": "llamore-default",
        "type": "markdown",
        "url": "https://pad.gwdg.de/s/LSqaEtZyT/download"
    },
    {
        "variant_id": "llamore-default",
        "type": "html",
        "url": "https://pad.gwdg.de/s/LSqaEtZyT"
    }
]


def get_supported_variants() -> list[str]:
    """Return list of supported LLamore variants."""
    return SUPPORTED_VARIANTS.copy()


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
