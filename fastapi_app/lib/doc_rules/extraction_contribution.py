"""
Extraction-time contribution: lets an extractor plugin resolve its shipped
prompt/rule-fragment files through the document rules registry, so a user's
selected override (if any) is used instead of the shipped default. See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("Extraction-time contribution").
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from fastapi_app.config import get_settings
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.doc_rules.resource_key import normalize_resource_key
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore
from fastapi_app.lib.utils.annotation_rules_utils import resolve_forge_permalink


@dataclass(frozen=True)
class ExtractionFragment:
    """One shipped prompt/rule-fragment file an extractor plugin contributes."""

    url: str    # the file's (branch-relative) git-forge blob URL, as committed
    file: Path  # local path to the shipped file, read for its current text
    label: str  # human-readable label; becomes the editorialDecl interpretation's @n


@dataclass(frozen=True)
class ResolvedFragment:
    """What an extractor plugin actually uses: the resolved permalink, label, and text to feed the model/prompt."""

    url_pinned: str  # url resolved to a SHA-pinned permalink
    label: str
    text: str        # the user's selected override text if any, else the shipped file's current text


def for_extraction(
    user: Optional[str],
    descriptors: list[ExtractionFragment],
    store: DocumentRulesStore,
) -> list[ResolvedFragment]:
    """
    Resolve each descriptor: pin its URL to the current commit SHA, seed the
    annotation-rules cache with the shipped file's own current text under
    that pinned URL (so the resource is resolvable later without a live
    fetch - see git_forge_adapters.py's is_sha_pinned()/UrlCache's
    ignore_ttl for why this stays fresh indefinitely), then return the
    text to actually use: `user`'s selected "interpretation-ref" override
    for that resource, if any, else the shipped text. `user=None` never
    looks up an override (used text is always the shipped default).
    """
    cache = UrlCache(get_settings().annotation_rules_cache_dir)
    results: list[ResolvedFragment] = []
    for descriptor in descriptors:
        pinned_url = resolve_forge_permalink(descriptor.url, cache)
        shipped_text = descriptor.file.read_text(encoding="utf-8")
        cache.set_text(pinned_url, shipped_text)

        override_text = None
        if user is not None:
            resource_key = normalize_resource_key(pinned_url)
            override_text = store.get_selected_override_text("interpretation-ref", resource_key, user)

        results.append(ResolvedFragment(
            url_pinned=pinned_url,
            label=descriptor.label,
            text=override_text if override_text is not None else shipped_text,
        ))
    return results
