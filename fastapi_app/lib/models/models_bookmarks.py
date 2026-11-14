"""
Pydantic models of the bookmarks API (`/api/v1/bookmarks`).
"""

from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints

BookmarkTitle = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class BookmarkItem(BaseModel):
    """A bookmark of the current user on an element below `/TEI/text` of a file."""

    id: str
    stable_id: str
    doc_id: str
    doc_label: str
    path: str = Field(description="XPath of the element, e.g. `/TEI/text/body/listBibl/bibl[3]`")
    fingerprint: str | None = Field(None, description="Fingerprint of the element's content when it was bookmarked")
    element: str = Field(description="Local name of the element")
    title: str
    excerpt: str | None = Field(None, description="Start of the element's text when it was bookmarked")
    available: bool = Field(description="False if the file was deleted or the user can no longer view it")
    created_at: str
    updated_at: str


class BookmarkListResponse(BaseModel):
    """The bookmarks of the current user, newest first."""

    items: list[BookmarkItem]


class CreateBookmarkRequest(BaseModel):
    """A new bookmark."""

    stable_id: str
    path: Annotated[str, StringConstraints(max_length=1000)]
    fingerprint: Annotated[str, StringConstraints(max_length=64)] | None = None
    element: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    title: BookmarkTitle
    excerpt: Annotated[str, StringConstraints(max_length=300)] | None = None


class UpdateBookmarkRequest(BaseModel):
    """A new title of a bookmark."""

    title: BookmarkTitle


class DeleteBookmarkResponse(BaseModel):
    """Result of deleting a bookmark."""

    deleted: bool
