"""GROBID plugin configuration."""

from fastapi_app.lib.plugins.plugin_tools import PluginConfigSpec, get_plugin_config
from fastapi_app.lib.utils.config_utils import get_config

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

# Maps variant_id to the XPath locations of training content.
# "grobid_path": element path in raw GROBID output (relative to root TEI element)
# "annotation_path": element path in stored document (relative to root TEI element)
# Variants not listed here use the default: content is in <text> in both contexts.
VARIANT_CONTENT_LOCATIONS: dict[str, dict[str, str]] = {
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
    ],
    "grobid.training.header.affiliation": [
        {
            "value": "//tei:affiliation",
            "label": "&lt;affiliation&gt;"
        }
    ],
    "grobid.training.header.authors": [
        {
            "value": "//tei:author",
            "label": "&lt;author&gt;"
        }
    ],
    "grobid.training.header.date": [
        {
            "value": "//tei:date",
            "label": "&lt;date&gt;"
        }
    ],
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
        "type": "markdown",
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
        "url": "https://grobid.readthedocs.io/en/latest/training/Bibliographical-references"
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


def get_variant_content_locations() -> dict[str, dict[str, str]]:
    """Return the content location mapping for all variants with non-default content placement."""
    import copy
    return copy.deepcopy(VARIANT_CONTENT_LOCATIONS)


def get_annotation_guides() -> list[dict]:
    """Return list of annotation guide configurations."""
    return ANNOTATION_GUIDES.copy()


ANNOTATION_TAGS_CUTOFF: dict[str, int] = {
    "grobid.training.segmentation": 6,
    "grobid.training.references.referenceSegmenter": 3,
    "grobid.training.references": 6,
}

ANNOTATION_TAGS: dict[str, list[dict]] = {
    "grobid.training.segmentation": [
        {"tag": "body", "label": "body", "color": "#89dceb", "priority": 1, "defaultAttributes": None, "description": "The main body of the document", "attributes": []},
        {"tag": "listBibl", "label": "listBibl", "color": "#f38ba8", "priority": 2, "defaultAttributes": None, "description": "Bibliographical section", "attributes": []},
        {"tag": "front", "label": "front", "color": "#89b4fa", "priority": 3, "defaultAttributes": None, "description": "Document header / front matter", "attributes": []},
        {"tag": "titlePage", "label": "titlePage", "color": "#cba6f7", "priority": 4, "defaultAttributes": None, "description": "Cover page", "attributes": []},
        {"tag": "note", "label": "note[foot]", "color": "#94e2d5", "priority": 5, "defaultAttributes": {"place": "footnote"}, "description": "Page footer or numbered footnote", "attributes": []},
        {"tag": "page", "label": "page", "color": "#f9e2af", "priority": 6, "defaultAttributes": None, "description": "Page number indicator", "attributes": []},
        {"tag": "div", "label": "acknowledgement", "color": "#a6e3a1", "priority": 7, "defaultAttributes": {"type": "acknowledgement"}, "description": "Acknowledgement statement in the annex", "attributes": []},
        {"tag": "div", "label": "toc", "color": "#f5c2e7", "priority": 8, "defaultAttributes": {"type": "toc"}, "description": "Table of contents", "attributes": []},
        {"tag": "note", "label": "note[head]", "color": "#74c7ec", "priority": 9, "defaultAttributes": {"place": "headnote"}, "description": "Page header / running head", "attributes": []},
        {"tag": "div", "label": "annex", "color": "#585b70", "priority": 10, "defaultAttributes": {"type": "annex"}, "description": "Any other annex section", "attributes": []},
        {"tag": "div", "label": "funding", "color": "#f2cdcd", "priority": 11, "defaultAttributes": {"type": "funding"}, "description": "Funding information annex", "attributes": []},
        {"tag": "div", "label": "conflict", "color": "#eba0ac", "priority": 12, "defaultAttributes": {"type": "conflict"}, "description": "Conflict of interest statement", "attributes": []},
        {"tag": "div", "label": "contribution", "color": "#b4befe", "priority": 13, "defaultAttributes": {"type": "contribution"}, "description": "Author contribution statement", "attributes": []},
        {"tag": "div", "label": "availability", "color": "#45475a", "priority": 14, "defaultAttributes": {"type": "availability"}, "description": "Data/code availability statement", "attributes": []},
    ],
    "grobid.training.references.referenceSegmenter": [
        {"tag": "bibl", "label": "bibl", "color": "#89dceb", "priority": 1, "defaultAttributes": None, "description": "An individual bibliographic reference", "attributes": []},
        {"tag": "bibl", "label": "bibl[footnote]", "color": "#94e2d5", "priority": 2, "defaultAttributes": {"type": "footnote"}, "description": "A note or comment that is not a bibliographic reference", "attributes": []},
        {"tag": "label", "label": "label", "color": "#a6e3a1", "priority": 3, "defaultAttributes": None, "description": "Reference number or footnote marker (e.g. [1], ¹)", "attributes": []},
    ],
    "grobid.training.references": [
        {"tag": "author", "label": "author", "color": "#89b4fa", "priority": 1, "defaultAttributes": None, "description": "Complete sequence of author names", "attributes": []},
        {"tag": "title", "label": "title[a]", "color": "#a6e3a1", "priority": 2, "defaultAttributes": {"level": "a"}, "description": "Article or chapter title (analytics)", "attributes": [{"name": "level", "values": ["a", "j", "m", "s"]}]},
        {"tag": "title", "label": "title[j]", "color": "#74c7ec", "priority": 3, "defaultAttributes": {"level": "j"}, "description": "Journal title", "attributes": [{"name": "level", "values": ["a", "j", "m", "s"]}]},
        {"tag": "date", "label": "date", "color": "#fab387", "priority": 4, "defaultAttributes": None, "description": "Publication date sequence", "attributes": []},
        {"tag": "biblScope", "label": "pages", "color": "#f9e2af", "priority": 5, "defaultAttributes": {"unit": "page"}, "description": "Full page range of the article", "attributes": []},
        {"tag": "title", "label": "title[m]", "color": "#94e2d5", "priority": 6, "defaultAttributes": {"level": "m"}, "description": "Monograph, proceedings, book, or thesis title", "attributes": [{"name": "level", "values": ["a", "j", "m", "s"]}]},
        {"tag": "publisher", "label": "publisher", "color": "#cba6f7", "priority": 7, "defaultAttributes": None, "description": "Publisher name; also used for corporate authors such as web pages", "attributes": []},
        {"tag": "biblScope", "label": "volume", "color": "#f5c2e7", "priority": 8, "defaultAttributes": {"unit": "volume"}, "description": "Volume number", "attributes": []},
        {"tag": "biblScope", "label": "issue", "color": "#eba0ac", "priority": 9, "defaultAttributes": {"unit": "issue"}, "description": "Issue / number", "attributes": []},
        {"tag": "orgName", "label": "orgName", "color": "#f38ba8", "priority": 10, "defaultAttributes": None, "description": "Institution for theses or technical reports", "attributes": []},
        {"tag": "pubPlace", "label": "pubPlace", "color": "#89dceb", "priority": 11, "defaultAttributes": None, "description": "Publication place or location of publishing institution", "attributes": []},
        {"tag": "editor", "label": "editor", "color": "#b4befe", "priority": 12, "defaultAttributes": None, "description": "Sequence of editor names", "attributes": []},
        {"tag": "ptr", "label": "URL", "color": "#74c7ec", "priority": 13, "defaultAttributes": {"type": "web"}, "description": "Web URL (exclude prefixes like 'URL:' and trailing periods)", "attributes": []},
        {"tag": "idno", "label": "idno", "color": "#45475a", "priority": 14, "defaultAttributes": None, "description": "Document identifier (DOI, arXiv, etc.)", "attributes": [{"name": "type", "values": ["DOI", "arXiv", "report"]}]},
        {"tag": "note", "label": "note", "color": "#9399b2", "priority": 15, "defaultAttributes": None, "description": "Any note not covered by another tag", "attributes": []},
        {"tag": "title", "label": "title[s]", "color": "#b4befe", "priority": 16, "defaultAttributes": {"level": "s"}, "description": "Series title", "attributes": [{"name": "level", "values": ["a", "j", "m", "s"]}]},
        {"tag": "orgName", "label": "collaboration", "color": "#f2cdcd", "priority": 17, "defaultAttributes": {"type": "collaboration"}, "description": "Project-based collaboration acting as an author group", "attributes": []},
        {"tag": "note", "label": "note[report]", "color": "#585b70", "priority": 18, "defaultAttributes": {"type": "report"}, "description": "Type of report or thesis (e.g. 'Ph.D. thesis', 'Technical Report')", "attributes": []},
    ],
}


def get_annotation_tags() -> dict[str, list[dict]]:
    """Return annotation tag definitions keyed by variant_id."""
    import copy
    return copy.deepcopy(ANNOTATION_TAGS)


def get_annotation_tags_cutoff() -> dict[str, int]:
    """Return per-variant top-level menu item counts."""
    return ANNOTATION_TAGS_CUTOFF.copy()
