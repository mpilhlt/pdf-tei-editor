"""
Line layout of documents: a registry of layout providers, one per variant.

The layout of a document tells, for every line of its `<text>` (as read by
`fastapi_app/lib/tei/zone_lines.py`), on which page it lies and how it looks (position on the
page, font, figures next to it, ...). The unit review uses it to cut zone documents into pages
(unit scheme `pages`), the LLM plugins to cut them into page windows and to give the model layout
hints. The core knows nothing about where a layout comes from: an extractor plugin registers a
provider for its variants (the grobid plugin reads GROBID's feature files), which returns the
layout of a document or None if it has none.

The frontend reads it through `GET /api/v1/files/{stable_id}/layout`.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field

from fastapi_app.lib.tei.zone_lines import LAYOUT_HINTS, ZoneLabel, zone_labels

logger = logging.getLogger(__name__)

PAGES_UNIT_PATH = "pages"
"""Unit path of the page review units of zone documents."""


@dataclass(frozen=True)
class LineLayout:
    """The layout of a document's lines: per line, its page index (0-based) and its layout hints."""

    pages: list[int]
    hints: list[list[str]] = field(default_factory=list)

    def __post_init__(self) -> None:
        unknown = {hint for line in self.hints for hint in line} - set(LAYOUT_HINTS)
        if unknown:
            raise ValueError(f"Unknown layout hints: {', '.join(sorted(unknown))}")

    def hints_of(self, line: int) -> list[str]:
        """The hints of a line ([] beyond the layout)."""
        return self.hints[line] if line < len(self.hints) else []


LayoutProvider = Callable[[str, str], "LineLayout | None"]
"""`provider(xml, doc_id)`: the layout of a document (its TEI content and document id), or None."""

_registry: dict[str, tuple[str, LayoutProvider]] = {}


def register_layout_provider(variant_id: str, plugin_id: str, provider: LayoutProvider) -> None:
    """Register (or replace) the layout provider of a variant."""
    _registry[variant_id] = (plugin_id, provider)


def unregister_layout_provider(variant_id: str) -> None:
    """Remove the layout provider of a variant, if any."""
    _registry.pop(variant_id, None)


def has_layout_provider(variant_id: str | None) -> bool:
    """Whether a provider is registered for the variant."""
    return bool(variant_id) and variant_id in _registry


def get_line_layout(xml: str, doc_id: str, variant_id: str | None) -> LineLayout | None:
    """
    The layout of a document from the provider of its variant; None if there is no provider, or
    the provider has no layout for the document (or fails, which is logged).
    """
    if not variant_id or variant_id not in _registry:
        return None
    plugin_id, provider = _registry[variant_id]
    try:
        return provider(xml, doc_id)
    except Exception as e:  # noqa: BLE001 - a failing provider means "no layout", not a server error
        logger.warning(f"Layout provider of plugin '{plugin_id}' failed for {doc_id} ({variant_id}): {e}")
        return None


def _extractor_infos() -> list[Mapping[str, object]]:
    from fastapi_app.lib.extraction.registry import ExtractorRegistry

    return ExtractorRegistry.get_instance().list_extractors(available_only=False)


def get_zone_labels(variant_id: str | None, infos: Sequence[Mapping[str, object]] | None = None) -> list[ZoneLabel] | None:
    """
    The zone labels an extractor declares for the variant (`zoneLabels` in its info), or None if
    the variant is not a zone document.
    """
    if not variant_id:
        return None
    for info in infos if infos is not None else _extractor_infos():
        declared = info.get("zoneLabels")
        if isinstance(declared, Mapping) and variant_id in declared:
            entries = declared[variant_id]
            if isinstance(entries, list):
                return zone_labels(entries)
    return None


MISSING_LAYOUT_MESSAGE = "The layout information of this document is missing. A fresh extraction of the document provides it."
"""Message shown where the layout of a zone document is required but missing."""
