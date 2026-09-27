"""
Resource key normalization and format inference for the document rules
registry. See docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("Resource key").
"""

import logging
from typing import Literal
from urllib.parse import urlsplit

from fastapi_app.lib.core.git_forge_adapters import GitForgeAdapterRegistry

logger = logging.getLogger(__name__)


def normalize_resource_key(url: str) -> str:
    """
    Normalize a resource URL to a key stable across which ref/commit a
    document happens to pin: the git-forge ref segment is replaced by a
    fixed placeholder (via the matching adapter's strip_ref()), any line-
    range fragment is retained. A URL no adapter recognizes - or one an
    adapter matches loosely (e.g. by host) but can't fully parse, such as
    a malformed hand-edited ref/@target - is used verbatim rather than
    raising, matching the fetch/permalink helpers in
    annotation_rules_utils.py, which apply the same "never block the
    caller" policy for adapter failures.
    """
    base_url, _, fragment = url.partition("#")
    adapter = GitForgeAdapterRegistry.get_instance().get_adapter_for(base_url)
    key_base = base_url
    if adapter is not None:
        try:
            key_base = adapter.strip_ref(base_url)
        except Exception as e:
            logger.warning(f"Could not normalize resource key for {base_url}, using it verbatim: {e}", exc_info=True)
    return f"{key_base}#{fragment}" if fragment else key_base


def infer_format(url: str) -> Literal["markdown", "text", "xml"]:
    """
    Infer a resource's editor format from its URL's file extension
    (fragment ignored): ".md"/".markdown" -> "markdown"; ".xml"/".rng" ->
    "xml"; anything else (including no extension) -> "text".
    """
    path = urlsplit(url.partition("#")[0]).path.lower()
    if path.endswith(".md") or path.endswith(".markdown"):
        return "markdown"
    if path.endswith(".xml") or path.endswith(".rng"):
        return "xml"
    return "text"
