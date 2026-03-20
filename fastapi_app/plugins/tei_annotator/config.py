"""
Constants and annotation schema builders for the tei-annotator plugin.
"""

from __future__ import annotations

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
