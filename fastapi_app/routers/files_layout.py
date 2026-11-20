"""
Line layout of a document (see fastapi_app/lib/tei/layout.py).

GET /api/v1/files/{stable_id}/layout - the page and layout hints of every line of `<text>`, from the
layout provider of the document's variant.
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..lib.core.dependencies import get_file_repository, get_file_storage, require_authenticated_user
from ..lib.permissions.access_control import check_file_access
from ..lib.repository.file_repository import FileRepository
from ..lib.storage.file_storage import FileStorage
from ..lib.tei.layout import MISSING_LAYOUT_MESSAGE, get_line_layout, has_layout_provider

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/files", tags=["files"])


class LineLayoutResponse(BaseModel):
    """The layout of a document's lines."""

    status: Literal["ok", "missing", "unsupported"] = Field(
        description="ok: the layout is in `pages` and `hints`; missing: the variant has a layout provider, but it has no layout for this document; unsupported: no layout provider for the variant"
    )
    pages: list[int] = Field(default_factory=list, description="Page index (0-based) of every line of <text>")
    hints: list[list[str]] = Field(default_factory=list, description="Layout hints of every line (e.g. top, repeated, bold)")
    message: str | None = Field(default=None, description="Why there is no layout (status missing)")


@router.get("/{stable_id}/layout", response_model=LineLayoutResponse)
def get_file_layout(
    stable_id: str,
    user: dict[str, object] = Depends(require_authenticated_user),
    file_repo: FileRepository = Depends(get_file_repository),
    file_storage: FileStorage = Depends(get_file_storage),
) -> LineLayoutResponse:
    """The page and layout hints of every line of the document's `<text>`."""
    file = file_repo.get_file_by_stable_id(stable_id)
    if file is None or file.file_type != "tei":
        raise HTTPException(status_code=404, detail=f"No TEI file with stable id {stable_id}")
    if not check_file_access(file, user, "read"):
        raise HTTPException(status_code=403, detail="You do not have permission to access this file")
    if not has_layout_provider(file.variant):
        return LineLayoutResponse(status="unsupported")
    content = file_storage.read_file(file.id, "tei")
    if content is None:
        raise HTTPException(status_code=404, detail=f"File content of {stable_id} not found")
    layout = get_line_layout(content.decode("utf-8"), file.doc_id, file.variant)
    if layout is None:
        return LineLayoutResponse(status="missing", message=MISSING_LAYOUT_MESSAGE)
    return LineLayoutResponse(status="ok", pages=layout.pages, hints=layout.hints)
