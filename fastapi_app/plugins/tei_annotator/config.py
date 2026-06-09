"""
Constants and annotation schema builders for the tei-annotator plugin.
"""

from __future__ import annotations

from fastapi_app.lib.plugins.plugin_tools import PluginConfigSpec, get_plugin_config

PLUGIN_CONFIG_SPECS: list[PluginConfigSpec] = [
    {
        "config_key": "tei-annotator.server.url",
        "env_var":    "TEI_ANNOTATOR_SERVER_URL",
        "default":     None,
        "description": "URL of the TEI Annotator webservice",
    },
    {
        "config_key": "tei-annotator.server.api-key",
        "env_var":    "TEI_ANNOTATOR_API_KEY",
        "default":     None,
        "description": "API key for authenticating with the TEI Annotator webservice",
    },
    {
        "config_key": "tei-annotator.provider",
        "env_var":    "TEI_ANNOTATOR_PROVIDER",
        "default":     None,
        "description": "LLM provider used by the TEI Annotator (e.g. openai, anthropic)",
    },
    {
        "config_key": "tei-annotator.model",
        "env_var":    "TEI_ANNOTATOR_MODEL",
        "default":     None,
        "description": "LLM model identifier used by the TEI Annotator for annotation",
    },
]


def init_plugin_config() -> None:
    """Register plugin config keys from environment variables."""
    for spec in PLUGIN_CONFIG_SPECS:
        get_plugin_config(**spec)


# ---------------------------------------------------------------------------
# Annotator service defaults
# ---------------------------------------------------------------------------

DEFAULT_PROVIDER   = "gemini"
DEFAULT_MODEL      = "gemini-2.5-flash"

# Placeholder used to round-trip <lb/> elements through plain text
LB_PLACEHOLDER = "\n"

# ---------------------------------------------------------------------------
# XML namespace
# ---------------------------------------------------------------------------

TEI_NS    = "http://www.tei-c.org/ns/1.0"
TEI_NSMAP = {"tei": TEI_NS}
TEI_LB    = f"{{{TEI_NS}}}lb"
TEI_BIBL  = f"{{{TEI_NS}}}bibl"


# ---------------------------------------------------------------------------
# Annotator registry access
# ---------------------------------------------------------------------------

def get_annotators() -> list:
    """Return the list of registered Annotator instances."""
    from fastapi_app.plugins.tei_annotator.annotators import ANNOTATORS  # noqa: PLC0415
    return ANNOTATORS
