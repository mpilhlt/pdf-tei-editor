"""
Pydantic models of the messages API (`/api/v1/messages`) and of the comment reply endpoint.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, Field


class MessageItem(BaseModel):
    """A review mark or comment addressed to the current user."""

    key: str
    kind: Literal["review", "comment", "mention"]
    reason: Literal["owner", "mention", "thread-author", "thread-mention"]
    doc_id: str
    stable_id: str
    doc_label: str
    author: str
    author_name: str | None = None
    text: str
    excerpt: str | None = None
    thread_id: str | None = None
    fingerprint: str | None = None
    settled: bool
    settled_note: str | None = None
    read: bool
    created_at: str


class MessageListResponse(BaseModel):
    """A page of messages, newest first."""

    items: list[MessageItem]
    total: int
    unread: int


class MessageCountResponse(BaseModel):
    """The number of unread messages."""

    unread: int


class MarkReadRequest(BaseModel):
    """Messages to mark as read or unread."""

    keys: Annotated[list[str], Field(max_length=1000)]
    read: bool = True


class RebuildResponse(BaseModel):
    """Result of rebuilding the message index."""

    files: int


class ReplyRequest(BaseModel):
    """A reply to a comment thread."""

    text: Annotated[str, Field(min_length=1, max_length=10000)]


class ReplyResponse(BaseModel):
    """The added reply."""

    stable_id: str
    thread_id: str
    comment_id: str
    annotation_xml: str
