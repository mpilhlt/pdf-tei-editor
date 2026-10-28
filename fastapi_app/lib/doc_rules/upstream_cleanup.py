"""
Which of a user's personal rule overrides the upstream guide already contains.

For each layer (human, machine) of a rule category, an override "is in
upstream" when its text equals the layer's section at the default branch head,
compared in repository form and ignoring sync markers and blank lines. That
is what the status reports: it predicts what updating the document's refs
brings. The removal instead compares with the section at the layer's URL as
the stored (re-pinned) document references it, so an override is deleted only
if the original the document now uses contains its text.

Anti-goal: an override whose text upstream does not contain must never be
reported as in upstream and never be deleted. Whenever a layer's upstream
section cannot be determined, nothing of that layer is marked.
"""

from dataclasses import dataclass, replace
from typing import Callable, Optional

import requests

from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.doc_rules.guide_sync import section_hash
from fastapi_app.lib.doc_rules.interpretation_ref_kind import InterpretationRefKind
from fastapi_app.lib.doc_rules.kinds import ResourceDescriptor
from fastapi_app.lib.doc_rules.rules_refresh import plan_resource_refresh
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore, OverrideRow
from fastapi_app.lib.doc_rules.upstream_proposal import (
    ProposalError,
    _adapter,
    _default_branch,
    _fetch_raw_file,
    _repo_path,
    _section,
    section_anchor,
)
from fastapi_app.lib.utils.annotation_rules_utils import RuleFetchError, derelativize_markdown_urls

_LAYER_ORDER = {"human": 0, "machine": 1}


class CategoryNotFoundError(Exception):
    """No rule category of the document has a layer with the given URL."""


@dataclass(frozen=True)
class LayerUpstreamStatus:
    """Upstream status of the caller's overrides of one layer; `in_upstream` and `kept` hold override ids."""

    layer: str
    url: str
    error: Optional[str]
    in_upstream: list[str]
    kept: list[str]


@dataclass(frozen=True)
class UpstreamStatus:
    """Upstream status of a whole rule category."""

    refs_behind: bool
    refresh_message: Optional[str]
    layers: list[LayerUpstreamStatus]


def category_layers(tei_content: str, url: str) -> list[ResourceDescriptor]:
    """
    The layer descriptors (human first, then machine) of the category that has
    `url` as the url or a related url of one of its layers.

    Raises:
        CategoryNotFoundError: if no category matches.
    """
    descriptors = InterpretationRefKind().discover(tei_content)
    for descriptor in descriptors:
        if url == descriptor.url or url in descriptor.related_urls:
            members = [d for d in descriptors if d.group == descriptor.group]
            return sorted(members, key=lambda d: _LAYER_ORDER.get(d.layer or "", len(_LAYER_ORDER)))
    raise CategoryNotFoundError(f"No rule category found for {url}")


def upstream_section(url: str, cache: UrlCache) -> str:
    """
    The section of `url`'s heading anchor in the file at the default branch
    head, in repository form.

    Raises:
        ProposalError: if the anchor cannot be determined or is gone.
        RuleFetchError: if the default branch or the file cannot be resolved.
        requests.RequestException: on a network error.
    """
    branch, main_url = _default_branch(_adapter(url), url, cache)
    return _section(_fetch_raw_file(main_url), section_anchor(url, cache), _repo_path(url)[1], branch)


def _normalized(text: str, url: str) -> str:
    """`text` with `\\n` line endings and same-repository links made absolute against `url`."""
    return derelativize_markdown_urls(text.replace("\r\n", "\n"), url)


def matches_upstream(text: str, upstream: str, url: str) -> bool:
    """Whether `text` equals the `upstream` section, ignoring sync markers, blank lines, trailing whitespace and link form."""
    return section_hash(_normalized(text, url)) == section_hash(_normalized(upstream, url))


def pinned_section(url: str) -> str:
    """
    The section at `url` itself (the original the document is pinned to), as
    the override editor resolves it.

    Raises:
        RuleFetchError: if the section cannot be resolved.
        requests.RequestException: on a network error.
    """
    return InterpretationRefKind().resolve_original(url)


class OverrideDeletionError(Exception):
    """Deleting an override failed; `deleted` holds the ids deleted before the failure."""

    def __init__(self, deleted: list[str], cause: Exception) -> None:
        super().__init__(f"Deleting the overrides failed after {len(deleted)} were deleted: {cause}")
        self.deleted = deleted


def _layer_status(layer: ResourceDescriptor, kind: InterpretationRefKind, store: DocumentRulesStore, owner: str, section_of: Callable[[str], str]) -> LayerUpstreamStatus:
    """
    Status of `owner`'s overrides of one layer compared with `section_of(layer.url)`.
    A layer whose overrides or comparison section cannot be read marks nothing.
    """
    layer_name = layer.layer or ""
    overrides: list[OverrideRow] = []
    try:
        overrides = store.list_overrides(kind.name, kind.resource_key(layer.url, strict=True), owner)
        section = section_of(layer.url)
    except (ProposalError, RuleFetchError, requests.RequestException) as e:
        return LayerUpstreamStatus(layer_name, layer.url, str(e), [], [o["id"] for o in overrides])
    in_upstream = [o["id"] for o in overrides if matches_upstream(o["text"], section, layer.url)]
    kept = [o["id"] for o in overrides if o["id"] not in in_upstream]
    return LayerUpstreamStatus(layer_name, layer.url, None, in_upstream, kept)


def _status(tei_content: str, url: str, store: DocumentRulesStore, owner: str, cache: UrlCache, section_of: Callable[[str], str]) -> UpstreamStatus:
    """upstream_status(), comparing each layer's overrides with `section_of(layer.url)`."""
    layers = category_layers(tei_content, url)
    kind = InterpretationRefKind()
    refs_behind = False
    refresh_message: Optional[str] = None
    try:
        outcome = plan_resource_refresh(tei_content, url, cache)
        refs_behind = outcome.status == "ok" and outcome.changed
        refresh_message = None if outcome.status == "ok" else outcome.message
    except (RuleFetchError, requests.RequestException) as e:
        refresh_message = str(e)
    return UpstreamStatus(
        refs_behind=refs_behind,
        refresh_message=refresh_message,
        layers=[_layer_status(layer, kind, store, owner, section_of) for layer in layers],
    )


def upstream_status(tei_content: str, url: str, store: DocumentRulesStore, owner: str, cache: UrlCache) -> UpstreamStatus:
    """
    Status of `owner`'s overrides of the category containing `url`, compared
    with the default branch head, and whether the document's refs lag behind
    what its extractor would generate now.

    Raises:
        CategoryNotFoundError: if no category matches `url`.
    """
    return _status(tei_content, url, store, owner, cache, lambda layer_url: upstream_section(layer_url, cache))


def remove_overrides_in_upstream(tei_content: str, url: str, store: DocumentRulesStore, owner: str, cache: UrlCache) -> UpstreamStatus:
    """
    Recompute the status (never trusting an earlier one) against the sections
    each layer's URL in `tei_content` is pinned to, and delete `owner`'s
    overrides whose text that pinned section contains. Pass the stored,
    re-pinned document. A deleted selected override falls back to the original
    via the selection's cascade.

    Returns:
        The recomputed status; its `in_upstream` lists are the ids actually
        deleted (an override already gone or not owned is not reported).

    Raises:
        CategoryNotFoundError: if no category matches `url`.
        OverrideDeletionError: if a deletion fails; deleting stops there.
    """
    status = _status(tei_content, url, store, owner, cache, pinned_section)
    deleted: list[str] = []
    layers: list[LayerUpstreamStatus] = []
    for layer in status.layers:
        layer_deleted: list[str] = []
        for override_id in layer.in_upstream:
            try:
                removed = store.delete_override(override_id, owner)
            except Exception as e:
                raise OverrideDeletionError(deleted, e) from e
            if removed:
                layer_deleted.append(override_id)
                deleted.append(override_id)
        layers.append(replace(layer, in_upstream=layer_deleted))
    return replace(status, layers=layers)
