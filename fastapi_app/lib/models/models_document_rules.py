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


class OkResponse(BaseModel):
    result: str = "ok"
