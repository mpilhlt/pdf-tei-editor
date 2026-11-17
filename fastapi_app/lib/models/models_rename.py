"""Pydantic models for renaming the ids of users, projects and collections."""

from pydantic import BaseModel, Field


class RenameRequest(BaseModel):
    """Request to rename the id of a user, project or collection."""
    new_id: str = Field(..., description="The new id")


class RenameResponse(BaseModel):
    """Result of a rename."""
    old_id: str = Field(..., description="The previous id")
    new_id: str = Field(..., description="The new id")
    changes: dict[str, int] = Field(..., description="Number of changed records per data store")
