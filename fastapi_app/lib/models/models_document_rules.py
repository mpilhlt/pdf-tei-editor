"""
Pydantic models for the document rules registry REST API. See
docs/superpowers/specs/2026-09-27-document-rules-registry-design.md
("REST API").
"""

from typing import Optional
from pydantic import BaseModel, Field

from fastapi_app.lib.doc_rules.kinds import ResourceFormat


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
    """Request to update an override's note and/or text. Omitted fields are left unchanged."""
    note: Optional[str] = None
    text: Optional[str] = None


class SetSelectionRequest(BaseModel):
    """Request to select an override for one resource, or `null` to select the original."""
    kind: str
    fragment_url: str
    override_id: Optional[str] = None


class ResourceRef(BaseModel):
    kind: str
    url: str


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


class ProposeChangeUrlRequest(BaseModel):
    """Request to build a URL that lets the caller's own forge session propose `text` as this resource's new upstream content."""
    url: str
    text: str


class ProposeChangeUrlResponse(BaseModel):
    """
    `url` is None when the resource's host isn't a recognized git forge - not
    an error, just nothing to propose a change through. `content_prefilled`
    is only ever True for a GitHub URL short enough to embed `text` directly;
    otherwise the frontend must fall back to a clipboard copy.
    """
    url: Optional[str] = None
    content_prefilled: bool = False
