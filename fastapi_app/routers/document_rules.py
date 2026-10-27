"""
REST API for the document rules registry: discovering, querying, and
overriding the resources a TEI document references (interpretation-ref
prompt/rule fragments and its schema). See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("REST API"). Write endpoints only ever touch the caller's own rows.

Handlers that may fetch a rule file (blocking `requests` calls, e.g. via
ResourceKind.resource_key() or resolve_original()) are plain `def`, so
FastAPI runs them in its threadpool instead of on the event loop.
/update-from-guide is an `async def` (it awaits the language model) and runs
its blocking parts in the threadpool via run_in_threadpool().
"""

import hashlib
import logging
from typing import Optional

import requests
from fastapi import APIRouter, Depends, HTTPException
from starlette.concurrency import run_in_threadpool

from ..config import get_settings
from ..lib.core.database import DatabaseManager
from ..lib.core.dependencies import (
    get_db,
    get_document_rules_store,
    get_file_storage,
    require_authenticated_user,
    require_reviewer_or_admin,
)
from ..lib.core.git_forge_adapters import GitForgeAdapterRegistry
from ..lib.core.url_cache import UrlCache
from ..lib.doc_rules.condense_prompt import resolve_condense_prompt
from ..lib.doc_rules.guide_sync import find_synced_human_commit, parse_sync_marker, sync_status
from ..lib.doc_rules.guide_update import (
    GuideChange,
    LayerSource,
    OriginalUnavailableError,
    build_update_prompts,
    clean_model_answer,
    gather_guide_change,
    guide_unchanged,
    layer_text,
)
from ..lib.doc_rules.interpretation_ref_kind import InterpretationRefKind
from ..lib.doc_rules.kinds import ResourceKind, get_resource_kind, list_resources
from ..lib.doc_rules.resource_key import infer_format, normalize_resource_key
from ..lib.doc_rules.rules_refresh import (
    RefreshPreconditionError,
    perform_refresh,
    plan_resource_refresh,
    preview_refresh,
    resolve_refresh_target,
)
from ..lib.doc_rules.storage import DocumentRulesStore, OverrideRow
from ..lib.llm import LLMProviderError, LLMProviderRegistry
from ..lib.llm.model_access import ModelAccessDenied, check_model_access
from ..lib.repository.file_repository import FileRepository
from ..lib.secrets import MissingSecretError, secret_required_detail
from ..lib.storage.file_storage import FileStorage
from ..lib.utils.annotation_rules_utils import (
    RuleFetchError,
    derelativize_markdown_urls,
    fetch_rule_excerpt,
    is_heading_anchor_fragment,
    is_line_range_fragment,
    splice_heading_section,
    splice_line_range,
)
from ..lib.models.models_document_rules import (
    CreateOverrideRequest,
    HumanChangeRequest,
    HumanChangeResponse,
    ListResourcesRequest,
    ListResourcesResponse,
    OkResponse,
    OverrideModel,
    ProposeChangeUrlRequest,
    ProposeChangeUrlResponse,
    QueryResourceRequest,
    QueryResourceResponse,
    RefTargetModel,
    RefreshOutcomeResponse,
    RefreshRequest,
    RefreshResourceRequest,
    RefreshResourceResponse,
    ResetSelectionRequest,
    ResourceDescriptorModel,
    ResourceRef,
    SelectedOverrideResponse,
    SelectionInfo,
    SelectionsRequest,
    SelectionsResponse,
    SetSelectionRequest,
    SyncStatusRequest,
    SyncStatusResponse,
    UpdateFromGuideRequest,
    UpdateFromGuideResponse,
    UpdateOverrideRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/document-rules", tags=["document-rules"])


def _override_to_model(override: OverrideRow, original_hash: Optional[str] = None) -> OverrideModel:
    """`original_hash` (sha256 of the current original) sets `outdated`; an empty base_hash (migrated override) is never outdated."""
    base_hash = override["base_hash"]
    return OverrideModel(
        id=override["id"],
        note=override["note"],
        text=override["text"],
        format=override["format"],
        created_at=override["created_at"],
        updated_at=override["updated_at"],
        outdated=original_hash is not None and base_hash != "" and base_hash != original_hash,
    )


def _resource_key(kind: ResourceKind, url: str, strict: bool = False) -> str:
    """
    The key overrides of `url` are stored under (may fetch, see
    InterpretationRefKind.resource_key()). Write and selection routes pass
    `strict`: a fetch failure is then a 502 instead of a fallback key, which
    would pass for a different resource; read routes keep the fallback.
    """
    if not strict:
        return kind.resource_key(url)
    try:
        return kind.resource_key(url, strict=True)
    except RuleFetchError as e:
        logger.error(f"Could not derive the resource key of {url}: {e}")
        raise HTTPException(status_code=502, detail=f"Could not fetch the resource to identify it: {e}")


def _resource_key_for(kind_name: str, url: str, strict: bool = False) -> str:
    """_resource_key() for a kind given by name; an unregistered kind falls back to normalize_resource_key()."""
    kind = get_resource_kind(kind_name)
    return _resource_key(kind, url, strict) if kind is not None else normalize_resource_key(url)


@router.post("/list", response_model=ListResourcesResponse)
def list_document_resources(
    request: ListResourcesRequest,
    user: dict = Depends(require_reviewer_or_admin),
) -> ListResourcesResponse:
    """List every resource the posted document content references. Used to build the "Edit document rules" submenu."""
    resources = list_resources(request.xml_string)
    return ListResourcesResponse(
        resources=[
            ResourceDescriptorModel(
                kind=r.kind, url=r.url, key=r.key, label=r.label, format=r.format,
                related_urls=r.related_urls, layer=r.layer, group=r.group,
            )
            for r in resources
        ]
    )


@router.post("/query", response_model=QueryResourceResponse)
def query_resource(
    request: QueryResourceRequest,
    user: dict = Depends(require_reviewer_or_admin),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> QueryResourceResponse:
    """Original text, the caller's overrides, and the caller's current selection for one resource."""
    kind = get_resource_kind(request.kind)
    if kind is None:
        raise HTTPException(status_code=400, detail=f"Unknown resource kind: {request.kind}")

    try:
        original_text = kind.resolve_original(request.url)
    except Exception as e:
        logger.error(f"Failed to resolve original text for {request.kind} {request.url}: {e}")
        raise HTTPException(status_code=502, detail=f"Could not fetch original resource: {e}")

    resource_key = _resource_key(kind, request.url)
    owner = user["username"]
    overrides = store.list_overrides(request.kind, resource_key, owner)
    selected_override_id = store.get_selection(request.kind, resource_key, owner)
    original_hash = hashlib.sha256(original_text.encode("utf-8")).hexdigest()

    return QueryResourceResponse(
        original_text=original_text,
        overrides=[_override_to_model(o, original_hash) for o in overrides],
        selected_override_id=selected_override_id,
    )


@router.post("/selected-override", response_model=SelectedOverrideResponse)
def get_selected_override(
    request: ResourceRef,
    user: dict = Depends(require_reviewer_or_admin),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> SelectedOverrideResponse:
    """The caller's selected override for one resource, without fetching the original (so `outdated` is always false)."""
    kind = get_resource_kind(request.kind)
    if kind is None:
        raise HTTPException(status_code=400, detail=f"Unknown resource kind: {request.kind}")
    owner = user["username"]
    override_id = store.get_selection(request.kind, _resource_key(kind, request.url), owner)
    override = store.get_override(override_id) if override_id is not None else None
    return SelectedOverrideResponse(override=_override_to_model(override) if override is not None else None)


@router.post("/overrides", response_model=OverrideModel)
def create_override(
    request: CreateOverrideRequest,
    user: dict = Depends(require_reviewer_or_admin),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> OverrideModel:
    """Create a new override, copying the resource's original text unless `text` is given."""
    kind = get_resource_kind(request.kind)
    if kind is None:
        raise HTTPException(status_code=400, detail=f"Unknown resource kind: {request.kind}")

    try:
        original_text = kind.resolve_original(request.fragment_url)
    except Exception as e:
        logger.error(f"Failed to resolve original text for {request.kind} {request.fragment_url}: {e}")
        raise HTTPException(status_code=502, detail=f"Could not fetch original resource: {e}")

    base_hash = hashlib.sha256(original_text.encode("utf-8")).hexdigest()
    override = store.create_override(
        kind=request.kind,
        resource_key=_resource_key(kind, request.fragment_url, strict=True),
        owner=user["username"],
        note=request.note,
        text=request.text if request.text is not None else original_text,
        format=infer_format(request.fragment_url),
        base_url=request.fragment_url,
        base_hash=base_hash,
    )
    return _override_to_model(override)


@router.put("/overrides/{override_id}", response_model=OverrideModel)
def update_override(
    override_id: str,
    request: UpdateOverrideRequest,
    user: dict = Depends(require_reviewer_or_admin),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> OverrideModel:
    """
    Update an override's note and/or text. Owner only. With `fragment_url`
    (the resource as currently shown), the override is rebased on that
    resource's current original, which clears its `outdated` flag.
    """
    owner = user["username"]
    base_hash: Optional[str] = None
    if request.fragment_url is not None:
        existing = store.get_override(override_id)
        if existing is None or existing["owner"] != owner:
            raise HTTPException(status_code=404, detail="Override not found or not owned by you")
        kind = get_resource_kind(existing["kind"])
        if kind is None:
            raise HTTPException(status_code=400, detail=f"Unknown resource kind: {existing['kind']}")
        if _resource_key(kind, request.fragment_url, strict=True) != existing["resource_key"]:
            raise HTTPException(status_code=400, detail="Override does not belong to this resource")
        try:
            original_text = kind.resolve_original(request.fragment_url)
        except Exception as e:
            logger.error(f"Failed to resolve original text for {existing['kind']} {request.fragment_url}: {e}")
            raise HTTPException(status_code=502, detail=f"Could not fetch original resource: {e}")
        base_hash = hashlib.sha256(original_text.encode("utf-8")).hexdigest()
    updated = store.update_override(
        override_id, owner, request.note, request.text, base_url=request.fragment_url, base_hash=base_hash
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Override not found or not owned by you")
    return _override_to_model(updated, base_hash)


@router.delete("/overrides/{override_id}", response_model=OkResponse)
async def delete_override(
    override_id: str,
    user: dict = Depends(require_reviewer_or_admin),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> OkResponse:
    """Delete an override. Owner only; also clears any selection pointing at it."""
    deleted = store.delete_override(override_id, user["username"])
    if not deleted:
        raise HTTPException(status_code=404, detail="Override not found or not owned by you")
    return OkResponse()


@router.put("/selection", response_model=OkResponse)
def set_selection(
    request: SetSelectionRequest,
    user: dict = Depends(require_reviewer_or_admin),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> OkResponse:
    """Select an override (or `null` for the original) for one resource."""
    resource_key = _resource_key_for(request.kind, request.fragment_url, strict=True)
    if request.override_id is not None:
        override = store.get_override(request.override_id)
        if override is None or override["owner"] != user["username"]:
            raise HTTPException(status_code=404, detail="Override not found or not owned by you")
        if override["kind"] != request.kind or override["resource_key"] != resource_key:
            raise HTTPException(status_code=400, detail="Override does not belong to this resource")
    store.set_selection(request.kind, resource_key, user["username"], request.override_id)
    return OkResponse()


@router.post("/selection/reset", response_model=OkResponse)
def reset_selection(
    request: ResetSelectionRequest,
    user: dict = Depends(require_reviewer_or_admin),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> OkResponse:
    """Clear the caller's selection for each listed resource, keeping all overrides."""
    resources = [(r.kind, _resource_key_for(r.kind, r.url, strict=True)) for r in request.resources]
    store.reset_selection(user["username"], resources)
    return OkResponse()


@router.post("/selections", response_model=SelectionsResponse)
def get_selections(
    request: SelectionsRequest,
    user: dict = Depends(require_reviewer_or_admin),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> SelectionsResponse:
    """
    Whether the caller currently has a selection (an override in use) for
    each listed resource - used to show an "overrides active" indicator
    without fetching every resource's full original/override text via
    repeated /query calls.
    """
    owner = user["username"]
    selections = [
        SelectionInfo(
            kind=r.kind,
            url=r.url,
            selected=store.get_selection(r.kind, _resource_key_for(r.kind, r.url), owner) is not None,
        )
        for r in request.resources
    ]
    return SelectionsResponse(selections=selections)


def _outcome_response(outcome) -> RefreshOutcomeResponse:
    return RefreshOutcomeResponse(
        available=outcome.available,
        changed=outcome.changed,
        entry_count=outcome.entry_count,
        variant_id=outcome.variant_id,
        message=outcome.message,
    )


@router.post("/refresh/preview", response_model=RefreshOutcomeResponse)
def refresh_preview(
    request: RefreshRequest,
    # Only these two refresh endpoints are reviewer/admin-gated - the rest
    # of this router is intentionally open to any authenticated user (see
    # validation.py's own comment on why schema overrides aren't
    # reviewer-gated: they only ever affect the calling user's own
    # validation/extraction, unlike a refresh, which rewrites the shared
    # document).
    user: dict = Depends(require_reviewer_or_admin),
    db: DatabaseManager = Depends(get_db),
    file_storage: FileStorage = Depends(get_file_storage),
) -> RefreshOutcomeResponse:
    """Read-only preview of what "Refresh document rules" would change for this document."""
    file_repo = FileRepository(db)
    try:
        target = resolve_refresh_target(file_repo, file_storage, request.xml, user)
    except RefreshPreconditionError as e:
        raise HTTPException(status_code=400, detail=str(e))

    cache = UrlCache(get_settings().annotation_rules_cache_dir)
    outcome = preview_refresh(target, cache)
    return _outcome_response(outcome)


@router.post("/refresh/execute", response_model=RefreshOutcomeResponse)
async def refresh_execute(
    request: RefreshRequest,
    user: dict = Depends(require_reviewer_or_admin),
    db: DatabaseManager = Depends(get_db),
    file_storage: FileStorage = Depends(get_file_storage),
) -> RefreshOutcomeResponse:
    """Perform the document rules refresh: regenerate and save if anything changed."""
    file_repo = FileRepository(db)
    try:
        target = resolve_refresh_target(file_repo, file_storage, request.xml, user)
    except RefreshPreconditionError as e:
        raise HTTPException(status_code=400, detail=str(e))

    cache = UrlCache(get_settings().annotation_rules_cache_dir)
    try:
        outcome = await perform_refresh(target, file_repo, file_storage, user.get("username"), cache)
    except RuntimeError as e:
        raise HTTPException(status_code=422, detail=str(e))

    return _outcome_response(outcome)


@router.post("/propose-change-url", response_model=ProposeChangeUrlResponse)
def propose_change_url(
    request: ProposeChangeUrlRequest,
    user: dict = Depends(require_authenticated_user),
) -> ProposeChangeUrlResponse:
    """
    Build a URL that lets the caller's own GitHub/GitLab session propose
    `text` as the resource's new upstream content - no server-side git write
    or stored credential involved (see
    docs/superpowers/specs/2026-09-28-document-rules-propose-upstream-design.md).
    Returns url=None when the resource's host isn't a recognized git forge.

    `text` is first passed through derelativize_markdown_urls() to undo this
    app's own internal absolute-URL rewrite of same-repo relative links (see
    fetch_rule_excerpt()) - otherwise a resource's original relative links
    would be replaced by this app's resolved, possibly SHA-pinned absolute
    form in the actual upstream file. The response's `text` field carries
    this rewritten text back to the frontend, which must copy it (not its
    own original text) to the clipboard.

    A line-range `url` (e.g. a machine-rules excerpt "#L10-L40") is first
    spliced back into the full upstream file at that range (see
    splice_line_range()), since the forge edit page replaces the whole
    file - so `text` in the response is then the whole file's new content.
    A heading-anchor `url` on a Markdown file (a human-guide section) is
    spliced the same way, replacing that heading's section.
    """
    cache = UrlCache(get_settings().annotation_rules_cache_dir)
    text = request.text
    base_url, _, fragment = request.url.partition("#")
    is_line_range = bool(fragment) and is_line_range_fragment(fragment)
    is_section = is_heading_anchor_fragment(fragment) and infer_format(base_url) == "markdown"
    if is_line_range or is_section:
        try:
            full_text = fetch_rule_excerpt(base_url, cache)
            if is_line_range:
                text = splice_line_range(full_text, fragment, text)
            else:
                text = splice_heading_section(full_text, fragment, text)
        except Exception as e:
            logger.error(f"Could not splice the edited excerpt into {base_url}: {e}", exc_info=True)
            raise HTTPException(status_code=502, detail=f"Could not splice the edit into the upstream file: {e}")
    text = derelativize_markdown_urls(text, request.url)
    for adapter in GitForgeAdapterRegistry.get_instance().all_adapters():
        try:
            target = adapter.build_propose_change_url(request.url, text, cache)
        except Exception as e:
            logger.error(
                f"Could not build propose-change URL via {type(adapter).__name__} for {request.url}: {e}",
                exc_info=True,
            )
            raise HTTPException(status_code=502, detail=f"Could not build the upstream link: {e}")
        if target is not None:
            return ProposeChangeUrlResponse(url=target.url, content_prefilled=target.content_prefilled, text=text)
    return ProposeChangeUrlResponse(url=None, content_prefilled=False, text=text)


@router.post("/refresh-resource", response_model=RefreshResourceResponse)
def refresh_resource(
    request: RefreshResourceRequest,
    # Same gate as /refresh/preview and /refresh/execute - this endpoint
    # exists purely to support the same reviewer/admin-only "Document
    # rules" editing feature (see the "Server-side gating" note on the
    # other now-gated routes in this router, above).
    user: dict = Depends(require_reviewer_or_admin),
    db: DatabaseManager = Depends(get_db),
    file_storage: FileStorage = Depends(get_file_storage),
) -> RefreshResourceResponse:
    """
    Compute what one interpretation-ref resource's <ref>s should be now,
    without writing anything - the document edit itself happens client-side
    (see docs/superpowers/specs/2026-09-29-document-rules-reset-to-original-design.md,
    "Frontend design").
    """
    file_repo = FileRepository(db)
    try:
        target = resolve_refresh_target(file_repo, file_storage, request.xml, user)
    except RefreshPreconditionError as e:
        raise HTTPException(status_code=400, detail=str(e))

    cache = UrlCache(get_settings().annotation_rules_cache_dir)
    outcome = plan_resource_refresh(target.tei_content, request.url, cache)
    return RefreshResourceResponse(
        status=outcome.status,
        refs=[RefTargetModel(**ref) for ref in outcome.refs],
        changed=outcome.changed,
        message=outcome.message,
    )


def _layer_text_or_502(kind: InterpretationRefKind, url: str, store: DocumentRulesStore, owner: str) -> tuple[str, LayerSource]:
    """layer_text(), with a failure to resolve the original reported as 502."""
    try:
        return layer_text(kind, url, store, owner)
    except OriginalUnavailableError as e:
        logger.error(f"Failed to resolve original text for {url}: {e}")
        raise HTTPException(status_code=502, detail=f"Could not fetch original resource: {e}")


@router.post("/sync-status", response_model=SyncStatusResponse)
def get_sync_status(
    request: SyncStatusRequest,
    user: dict = Depends(require_reviewer_or_admin),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> SyncStatusResponse:
    """
    Whether a human guideline section and its condensed machine section are
    in sync, per the sync marker in the machine section. Each layer's text is
    the caller's selected override if there is one, else the original.
    """
    kind = _interpretation_ref_kind()
    owner = user["username"]
    human_text, human_source = _layer_text_or_502(kind, request.human_url, store, owner)
    machine_text, machine_source = _layer_text_or_502(kind, request.machine_url, store, owner)
    status = sync_status(human_text, machine_text, request.human_url, request.machine_url)
    marker = parse_sync_marker(machine_text)
    synced_commit: Optional[str] = None
    if marker is not None and status in ("machine_outdated", "both_changed"):
        cache = UrlCache(get_settings().annotation_rules_cache_dir)
        synced_commit = find_synced_human_commit(request.human_url, marker, cache)
    return SyncStatusResponse(
        status=status,
        human_source=human_source,
        machine_source=machine_source,
        base=marker.base if marker is not None else None,
        synced_commit=synced_commit,
    )


def _interpretation_ref_kind() -> InterpretationRefKind:
    kind = get_resource_kind("interpretation-ref")
    if not isinstance(kind, InterpretationRefKind):
        raise HTTPException(status_code=500, detail="Resource kind interpretation-ref is not registered")
    return kind


def _gather_guide_change_or_502(human_url: str, machine_url: str, store: DocumentRulesStore, owner: str) -> GuideChange:
    """gather_guide_change(), with a failure to resolve an original reported as 502."""
    cache = UrlCache(get_settings().annotation_rules_cache_dir)
    try:
        return gather_guide_change(_interpretation_ref_kind(), human_url, machine_url, store, owner, cache)
    except OriginalUnavailableError as e:
        logger.error(f"Failed to resolve original text for {human_url} or {machine_url}: {e}")
        raise HTTPException(status_code=502, detail=f"Could not fetch original resource: {e}")


def _upstream_error_message(error: requests.RequestException) -> str:
    """The provider's own error message if the failed response carries one, else the exception text."""
    if error.response is not None:
        try:
            message = error.response.json().get("error", {}).get("message")
        except (ValueError, AttributeError):
            message = None
        if isinstance(message, str) and message:
            return message
    return str(error)


def _llm_request_error(provider_id: str, error: LLMProviderError | requests.RequestException) -> HTTPException:
    """The 502 for a failed request to the language model provider (logged)."""
    logger.warning(f"document-rules: provider '{provider_id}' failed: {error}")
    message = _upstream_error_message(error) if isinstance(error, requests.RequestException) else str(error)
    return HTTPException(status_code=502, detail=f"LLM provider request failed: {message}")


@router.post("/human-change", response_model=HumanChangeResponse)
def get_human_change(
    request: HumanChangeRequest,
    user: dict = Depends(require_reviewer_or_admin),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> HumanChangeResponse:
    """
    The change of a human guideline section since its machine section was
    last synced (delta mode), or the whole section if no sync base is found
    (align mode), together with the current machine section. Each layer's
    text is the caller's selected override if there is one, else the original.
    """
    change = _gather_guide_change_or_502(request.human_url, request.machine_url, store, user["username"])
    return HumanChangeResponse(
        mode=change.mode,
        old_human=change.old_human,
        new_human=change.new_human,
        machine=change.machine_full,
        base_commit=change.base_commit,
        unchanged=guide_unchanged(change, request.human_url),
    )


@router.post("/update-from-guide", response_model=UpdateFromGuideResponse)
async def update_from_guide(
    request: UpdateFromGuideRequest,
    user: dict = Depends(require_reviewer_or_admin),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> UpdateFromGuideResponse:
    """
    Have a language model update the machine section from the change of its
    human section (see /human-change) and return the proposed text. Nothing is
    stored; the caller saves an accepted proposal as an override.
    """
    owner = user["username"]
    try:
        # reads the user's stored secret, so it runs off the event loop
        provider = await run_in_threadpool(LLMProviderRegistry.get_instance().get_provider_for_user, request.provider_id, owner)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except MissingSecretError as e:
        raise HTTPException(status_code=428, detail=secret_required_detail(e)) from e
    try:
        # may list the provider's models, so its connection errors are handled like those of the completion
        await run_in_threadpool(check_model_access, provider, request.model_id, user)
    except ModelAccessDenied as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except (LLMProviderError, requests.RequestException) as e:
        raise _llm_request_error(request.provider_id, e) from e

    change = await run_in_threadpool(_gather_guide_change_or_502, request.human_url, request.machine_url, store, owner)
    try:
        condense_prompt = await run_in_threadpool(resolve_condense_prompt, request.xml, request.human_url)
    except Exception as e:
        logger.exception(f"Could not resolve the condensing prompt for {request.human_url}")
        raise HTTPException(status_code=500, detail="Could not resolve the condensing prompt") from e
    system_prompt, user_prompt = build_update_prompts(change, condense_prompt)

    try:
        answer = await provider.chat_completion(request.model_id, system_prompt, user_prompt, temperature=0.2)
    except (LLMProviderError, requests.RequestException) as e:
        raise _llm_request_error(request.provider_id, e) from e

    try:
        proposed = clean_model_answer(answer, change)
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return UpdateFromGuideResponse(
        mode=change.mode,
        old_human=change.old_human,
        new_human=change.new_human,
        machine=change.machine_full,
        proposed=proposed,
        base_commit=change.base_commit,
        unchanged=guide_unchanged(change, request.human_url),
    )
