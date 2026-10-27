"""
Pydantic models for the document rules registry REST API. See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("REST API").
"""

from typing import Literal, Optional
from pydantic import BaseModel, Field

from fastapi_app.lib.doc_rules.guide_sync import SyncStatus
from fastapi_app.lib.doc_rules.kinds import ResourceFormat, ResourceLayer


class ResourceDescriptorModel(BaseModel):
    """One resource a document references, as returned by /list."""
    kind: str
    url: str
    key: str
    label: str
    format: ResourceFormat
    related_urls: list[str] = Field(
        default_factory=list,
        description="Every URL in the document referring to this same resource (including `url`); "
        "e.g. an interpretation-ref entry's human and auto-derived machine ref share one resource "
        "but have different target URLs.",
    )
    layer: Optional[ResourceLayer] = Field(
        default=None,
        description="Which layer of a multi-layer resource this is (\"human\" guide or \"machine\" rules); null for kinds without layers.",
    )
    group: Optional[str] = Field(
        default=None,
        description="Resources sharing a group are layers of one rule category (e.g. \"interpretation-ref:primary\"); null for kinds without layers.",
    )


class ListResourcesRequest(BaseModel):
    """Request to discover the resources a (possibly unsaved) document references."""
    xml_string: str = Field(..., min_length=1)


class ListResourcesResponse(BaseModel):
    resources: list[ResourceDescriptorModel]


class QueryResourceRequest(BaseModel):
    """Request for one resource's original text, overrides, and selection."""
    kind: str
    url: str


class OverrideModel(BaseModel):
    """
    One user-owned editable copy of a resource, as exposed over the REST
    API. DocumentRulesStore's raw override dict also carries kind,
    resource_key, owner, base_url, and base_hash - intentionally not
    exposed here; the router builds this model from a subset of that
    dict's fields, not by passing it through wholesale.
    """
    id: str
    note: str
    text: str
    format: ResourceFormat
    created_at: str
    updated_at: str
    outdated: bool = Field(
        False,
        description="True when the original has changed since this override was copied from it (set by /query only; overrides migrated without a base hash are never outdated).",
    )


class QueryResourceResponse(BaseModel):
    original_text: str
    overrides: list[OverrideModel]
    selected_override_id: Optional[str] = Field(
        None, description="The caller's selected override id, or null if this resource currently uses the original."
    )


class CreateOverrideRequest(BaseModel):
    """Request to create a new override. `text` defaults to the resource's original text when omitted."""
    kind: str
    fragment_url: str
    note: str = ""
    text: Optional[str] = None


class UpdateOverrideRequest(BaseModel):
    """
    Request to update an override's note and/or text. Omitted fields are left
    unchanged. `fragment_url`, the URL of the resource as currently shown,
    rebases the override on that resource's current original, which clears
    its `outdated` flag.
    """
    note: Optional[str] = None
    text: Optional[str] = None
    fragment_url: Optional[str] = None


class SetSelectionRequest(BaseModel):
    """Request to select an override for one resource, or `null` to select the original."""
    kind: str
    fragment_url: str
    override_id: Optional[str] = None


class ResourceRef(BaseModel):
    kind: str
    url: str


class SelectedOverrideResponse(BaseModel):
    """The caller's selected override for one resource, or null if it currently uses the original."""
    override: Optional[OverrideModel] = None


class ResetSelectionRequest(BaseModel):
    """Request to clear the caller's selection for each listed resource. Overrides are kept."""
    resources: list[ResourceRef]


class SelectionInfo(BaseModel):
    """Whether the caller currently has an override selected for one resource."""
    kind: str
    url: str
    selected: bool


class SelectionsRequest(BaseModel):
    """Request the caller's selection status for each listed resource."""
    resources: list[ResourceRef]


class SelectionsResponse(BaseModel):
    selections: list[SelectionInfo]


class OkResponse(BaseModel):
    result: str = "ok"


class RefreshRequest(BaseModel):
    """Request to preview or execute a "Refresh document rules" action. `xml` is the target document's stable_id."""
    xml: str


class RefreshOutcomeResponse(BaseModel):
    """
    Response to both /refresh/preview and /refresh/execute.

    `available=False` means no rules-refresh provider is registered for
    this document's extractor - not an error, just nothing to refresh.
    `changed` is always False from /preview (nothing is ever written
    there); from /execute it reflects whether anything was actually
    rewritten.
    """
    available: bool
    changed: bool
    entry_count: int
    variant_id: Optional[str] = None
    message: str


class RefTargetModel(BaseModel):
    target: str
    content_type: Optional[str]
    subtype: Literal["human", "machine"]


class RefreshResourceRequest(BaseModel):
    """Request to refresh one interpretation-ref resource's <ref>s from upstream. `xml` is the target document's stable_id."""
    xml: str
    url: str


class RefreshResourceResponse(BaseModel):
    """
    Response to POST /document-rules/refresh-resource.

    `status` meanings: "unavailable" (no provider for this document's
    extractor), "not_found" (`url` isn't a ref target of any
    current editorialDecl entry), "orphaned" (the entry's category no
    longer exists in a freshly-built entries list), "ok" (`refs`/`changed`
    populated). See plan_resource_refresh()'s docstring.
    """
    status: Literal["ok", "unavailable", "not_found", "orphaned"]
    refs: list[RefTargetModel] = Field(default_factory=list)
    changed: bool = False
    message: str


class ProposeChangeUrlRequest(BaseModel):
    """Request to build a URL that lets the caller's own forge session propose `text` as this resource's new upstream content."""
    url: str
    text: str


class ProposeChangeUrlResponse(BaseModel):
    """
    `url` is None when the resource's host isn't a recognized git forge - not
    an error, just nothing to propose a change through. `content_prefilled`
    is only ever True for a GitHub URL short enough to embed `text` directly;
    otherwise the frontend must fall back to a clipboard copy. `text` is the
    request's `text` with same-repo absolute links rewritten back to the
    relative form they'd have upstream (see
    `annotation_rules_utils.derelativize_markdown_urls()`) - the frontend
    must copy *this*, not its own original text, to the clipboard.
    """
    url: Optional[str] = None
    content_prefilled: bool = False
    text: str = ""


class SyncStatusRequest(BaseModel):
    """Request for the sync status of a human guideline section and its condensed machine section."""
    human_url: str
    machine_url: str


class SyncStatusResponse(BaseModel):
    """
    `*_source` tells whether the layer text compared was the original or the
    caller's selected override. `synced_commit` is the guide commit the machine
    section was last synced with; only looked up for `machine_outdated` and
    `both_changed`, and null if not found.
    """
    status: SyncStatus
    human_source: Literal["original", "override"]
    machine_source: Literal["original", "override"]
    base: Optional[str] = None
    synced_commit: Optional[str] = None


class HumanChangeRequest(BaseModel):
    """Request for the change of a human guideline section since its machine section was last synced."""
    human_url: str
    machine_url: str


class HumanChangeResponse(BaseModel):
    """
    `mode` is "delta" if the guide commit the machine section was synced with
    was found (`old_human` and `base_commit` set), else "align". `old_human`
    and `new_human` have their same-repository links in relative form;
    `machine` is the user's machine text, sync marker included, with its links
    in the absolute form of an override. `unchanged` is True in delta mode
    if the human section has not changed since the sync (same hash).
    """
    mode: Literal["delta", "align"]
    old_human: Optional[str] = None
    new_human: str
    machine: str
    base_commit: Optional[str] = None
    unchanged: bool


class ProposePatchRequest(BaseModel):
    """Request for the upstream patch of a rule category's human and/or machine section."""
    human_url: str
    machine_url: str
    include_human: bool
    include_machine: bool
    label: str = Field(..., description="The rule category's label, e.g. \"Data correction\".")


class ProposedFileModel(BaseModel):
    """A changed repository file: its path and its whole text before and after the proposal."""
    path: str
    before: str
    after: str


class ProposePatchResponse(BaseModel):
    """The changed files (human first), the unified diff `git apply` accepts, its download file name, and the default branch it targets."""
    files: list[ProposedFileModel]
    patch: str
    filename: str
    branch: str


class UpdateFromGuideRequest(BaseModel):
    """Request to have a language model update a machine section from its human section."""
    xml: str
    human_url: str
    machine_url: str
    provider_id: str
    model_id: str


class UpdateFromGuideResponse(BaseModel):
    """
    Same fields as HumanChangeResponse, plus `proposed`, the model's updated
    machine section in the same form as `machine`, so that a diff of the two
    shows only the model's changes.
    """
    mode: Literal["delta", "align"]
    old_human: Optional[str] = None
    new_human: str
    machine: str
    proposed: str
    base_commit: Optional[str] = None
    unchanged: bool
