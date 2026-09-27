"""
REST API for the document rules registry: discovering, querying, and
overriding the resources a TEI document references (interpretation-ref
prompt/rule fragments and its schema). See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("REST API"). Write endpoints only ever touch the caller's own rows.
"""

import hashlib
import logging

from fastapi import APIRouter, Depends, HTTPException

from ..config import get_settings
from ..lib.core.database import DatabaseManager
from ..lib.core.dependencies import (
    get_db,
    get_document_rules_store,
    get_file_storage,
    require_authenticated_user,
    require_reviewer_or_admin,
)
from ..lib.core.url_cache import UrlCache
from ..lib.doc_rules.kinds import get_resource_kind, list_resources
from ..lib.doc_rules.resource_key import infer_format, normalize_resource_key
from ..lib.doc_rules.rules_refresh import (
    RefreshPreconditionError,
    perform_refresh,
    preview_refresh,
    resolve_refresh_target,
)
from ..lib.doc_rules.storage import DocumentRulesStore
from ..lib.repository.file_repository import FileRepository
from ..lib.storage.file_storage import FileStorage
from ..lib.models.models_document_rules import (
    CreateOverrideRequest,
    ListResourcesRequest,
    ListResourcesResponse,
    OkResponse,
    OverrideModel,
    QueryResourceRequest,
    QueryResourceResponse,
    RefreshOutcomeResponse,
    RefreshRequest,
    ResetSelectionRequest,
    ResourceDescriptorModel,
    SetSelectionRequest,
    UpdateOverrideRequest,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/document-rules", tags=["document-rules"])


def _override_to_model(override: dict) -> OverrideModel:
    return OverrideModel(
        id=override["id"],
        note=override["note"],
        text=override["text"],
        format=override["format"],
        created_at=override["created_at"],
        updated_at=override["updated_at"],
    )


@router.post("/list", response_model=ListResourcesResponse)
async def list_document_resources(
    request: ListResourcesRequest,
    user: dict = Depends(require_authenticated_user),
) -> ListResourcesResponse:
    """List every resource the posted document content references. Used to build the "Edit prompts/schemas" submenu."""
    resources = list_resources(request.xml_string)
    return ListResourcesResponse(
        resources=[
            ResourceDescriptorModel(kind=r.kind, url=r.url, key=r.key, label=r.label, format=r.format)
            for r in resources
        ]
    )


@router.post("/query", response_model=QueryResourceResponse)
async def query_resource(
    request: QueryResourceRequest,
    user: dict = Depends(require_authenticated_user),
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

    resource_key = normalize_resource_key(request.url)
    owner = user["username"]
    overrides = store.list_overrides(request.kind, resource_key, owner)
    selected_override_id = store.get_selection(request.kind, resource_key, owner)

    return QueryResourceResponse(
        original_text=original_text,
        overrides=[_override_to_model(o) for o in overrides],
        selected_override_id=selected_override_id,
    )


@router.post("/overrides", response_model=OverrideModel)
async def create_override(
    request: CreateOverrideRequest,
    user: dict = Depends(require_authenticated_user),
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
        resource_key=normalize_resource_key(request.fragment_url),
        owner=user["username"],
        note=request.note,
        text=request.text if request.text is not None else original_text,
        format=infer_format(request.fragment_url),
        base_url=request.fragment_url,
        base_hash=base_hash,
    )
    return _override_to_model(override)


@router.put("/overrides/{override_id}", response_model=OverrideModel)
async def update_override(
    override_id: str,
    request: UpdateOverrideRequest,
    user: dict = Depends(require_authenticated_user),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> OverrideModel:
    """Update an override's note and/or text. Owner only."""
    updated = store.update_override(override_id, user["username"], request.note, request.text)
    if updated is None:
        raise HTTPException(status_code=404, detail="Override not found or not owned by you")
    return _override_to_model(updated)


@router.delete("/overrides/{override_id}", response_model=OkResponse)
async def delete_override(
    override_id: str,
    user: dict = Depends(require_authenticated_user),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> OkResponse:
    """Delete an override. Owner only; also clears any selection pointing at it."""
    deleted = store.delete_override(override_id, user["username"])
    if not deleted:
        raise HTTPException(status_code=404, detail="Override not found or not owned by you")
    return OkResponse()


@router.put("/selection", response_model=OkResponse)
async def set_selection(
    request: SetSelectionRequest,
    user: dict = Depends(require_authenticated_user),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> OkResponse:
    """Select an override (or `null` for the original) for one resource."""
    resource_key = normalize_resource_key(request.fragment_url)
    if request.override_id is not None:
        override = store.get_override(request.override_id)
        if override is None or override["owner"] != user["username"]:
            raise HTTPException(status_code=404, detail="Override not found or not owned by you")
        if override["kind"] != request.kind or override["resource_key"] != resource_key:
            raise HTTPException(status_code=400, detail="Override does not belong to this resource")
    store.set_selection(request.kind, resource_key, user["username"], request.override_id)
    return OkResponse()


@router.post("/selection/reset", response_model=OkResponse)
async def reset_selection(
    request: ResetSelectionRequest,
    user: dict = Depends(require_authenticated_user),
    store: DocumentRulesStore = Depends(get_document_rules_store),
) -> OkResponse:
    """Clear the caller's selection for each listed resource, keeping all overrides."""
    resources = [(r.kind, normalize_resource_key(r.url)) for r in request.resources]
    store.reset_selection(user["username"], resources)
    return OkResponse()


def _outcome_response(outcome) -> RefreshOutcomeResponse:
    return RefreshOutcomeResponse(
        available=outcome.available,
        changed=outcome.changed,
        entry_count=outcome.entry_count,
        variant_id=outcome.variant_id,
        message=outcome.message,
    )


@router.post("/refresh/preview", response_model=RefreshOutcomeResponse)
async def refresh_preview(
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
