"""Pydantic models for permissions API (granular mode only)."""

from pydantic import BaseModel, field_validator
from datetime import datetime
from typing import Literal


class DocumentPermissionsModel(BaseModel):
    """Document permissions response model."""
    stable_id: str
    visibility: Literal['collection', 'owner']
    editability: Literal['collection', 'owner']
    owner: str
    created_at: datetime
    updated_at: datetime


class SetPermissionsRequest(BaseModel):
    """Request to set artifact permissions."""
    stable_id: str
    visibility: Literal['collection', 'owner']
    editability: Literal['collection', 'owner']
    owner: str

    @field_validator('visibility', 'editability')
    @classmethod
    def validate_permission_values(cls, v: str) -> str:
        if v not in ('collection', 'owner'):
            raise ValueError(f"Invalid permission value: {v}")
        return v


class AccessControlModeResponse(BaseModel):
    """Response for access control mode query."""
    mode: Literal['role-based', 'owner-based', 'granular']
    default_visibility: Literal['collection', 'owner']
    default_editability: Literal['collection', 'owner']
