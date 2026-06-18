"""GROBID plugin configuration."""

import copy

from fastapi_app.lib.plugins.plugin_tools import PluginConfigSpec, get_plugin_config
from fastapi_app.lib.utils.config_utils import get_config

from fastapi_app.plugins.grobid.config.annotation_guides import ANNOTATION_GUIDES, AnnotationGuide
from fastapi_app.plugins.grobid.config.annotation_tags import ANNOTATION_TAGS, AnnotationTagsMap
from fastapi_app.plugins.grobid.config.content_locations import VARIANT_CONTENT_LOCATIONS, VariantContentLocations
from fastapi_app.plugins.grobid.config.form_options import FORM_OPTIONS, FormOptions
from fastapi_app.plugins.grobid.config.navigation import NAVIGATION_XPATH, NavigationXPath
from fastapi_app.plugins.grobid.config.variants import PROCESSING_FLAVORS, SUPPORTED_VARIANTS

PLUGIN_CONFIG_SPECS: list[PluginConfigSpec] = [
    {
        "config_key": "plugin.grobid.server.url",
        "env_var":    "GROBID_SERVER_URL",
        "default":     "",
        "description": "URL of the GROBID server (e.g. http://localhost:8070)",
    },
    {
        "config_key": "plugin.grobid.server.timeout",
        "env_var":    "GROBID_SERVER_TIMEOUT",
        "default":     10,
        "value_type":  "number",
        "description": "Timeout in seconds for GROBID server health-check requests",
    },
    {
        "config_key": "plugin.grobid.extraction.timeout",
        "env_var":    "GROBID_EXTRACTION_TIMEOUT",
        "default":     300,
        "value_type":  "number",
        "description": "Timeout in seconds for GROBID extraction requests",
    },
    {
        "config_key": "plugin.grobid.cache.disabled",
        "env_var":    "GROBID_DISABLE_CACHE",
        "default":     False,
        "value_type":  "boolean",
        "description": "Disable GROBID extraction cache; when true every upload triggers a fresh extraction",
    },
]


def init_plugin_config() -> None:
    """Register plugin config keys from environment variables."""
    for spec in PLUGIN_CONFIG_SPECS:
        get_plugin_config(**spec)


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


def is_grobid_cache_disabled() -> bool:
    """
    Return True if the GROBID training data cache is disabled.

    When True, every extraction fetches fresh data from the GROBID server,
    equivalent to always passing force_refresh=True. Controlled by the
    GROBID_DISABLE_CACHE environment variable.

    Returns:
        True if caching is disabled (default: False).
    """
    config = get_config()
    value = config.get("plugin.grobid.cache.disabled", default=False)
    if isinstance(value, bool):
        return value
    return str(value).lower() in ("1", "true", "yes", "on")


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


# Mapping from training variant ID to the suffix used in training ZIP entries.
# Each feature file entry is named `{hash}.training.{suffix}` (no extension).
# For most variants the suffix equals variant_id.removeprefix("grobid.training."),
# so only exceptions need to be listed here.
VARIANT_FEATURE_SUFFIXES: dict[str, str] = {}

# Variants whose feature files have one entry per PDF layout line (first word of
# the line as token), rather than one entry per individual token.
LINE_BASED_VARIANTS: set[str] = {"grobid.training.segmentation"}


def get_feature_suffix(variant_id: str) -> str:
    """Return the ZIP entry suffix for a training variant's feature file."""
    if variant_id in VARIANT_FEATURE_SUFFIXES:
        return VARIANT_FEATURE_SUFFIXES[variant_id]
    return variant_id.removeprefix("grobid.training.")


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


def get_supported_variants() -> list[str]:
    """Return list of supported GROBID training variants."""
    return SUPPORTED_VARIANTS.copy()


def get_processing_flavors() -> list[str]:
    """Return list of processing flavors."""
    return PROCESSING_FLAVORS.copy()


def get_form_options() -> FormOptions:
    """Return form options for the extraction dialog."""
    return copy.deepcopy(FORM_OPTIONS)


def get_navigation_xpath() -> NavigationXPath:
    """Return navigation XPath expressions for each variant."""
    return copy.deepcopy(NAVIGATION_XPATH)


def get_model_path(variant_id: str) -> str:
    """Return the GROBID model path for a training variant ID."""
    if variant_id in VARIANT_MODEL_PATHS:
        return VARIANT_MODEL_PATHS[variant_id]
    # Fallback: strip prefix and replace dots with slashes
    return variant_id.removeprefix("grobid.training.").replace(".", "/")


def get_variant_content_locations() -> VariantContentLocations:
    """Return the content location mapping for all variants with non-default content placement."""
    return copy.deepcopy(VARIANT_CONTENT_LOCATIONS)


def get_annotation_guides() -> list[AnnotationGuide]:
    """Return list of annotation guide configurations."""
    return ANNOTATION_GUIDES.copy()


def get_annotation_tags() -> AnnotationTagsMap:
    """Return annotation tag definitions keyed by variant_id."""
    return copy.deepcopy(ANNOTATION_TAGS)
