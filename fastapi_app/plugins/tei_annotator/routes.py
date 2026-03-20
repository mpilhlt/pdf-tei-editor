"""
Custom routes for the TEI Annotator plugin.

Provides:
  GET  /api/plugins/tei-annotator/annotators  — list available annotators
  POST /api/plugins/tei-annotator/annotate    — annotate a selected <bibl> element
"""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from lxml import etree
from pydantic import BaseModel
from fastapi_app.lib.utils.xml_utils import strip_namespaces

from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_db,
    get_file_storage,
    get_session_manager,
)
from fastapi_app.plugins.tei_annotator.annotators import get_annotator
from fastapi_app.plugins.tei_annotator.annotators.base import BaseAnnotator
from fastapi_app.plugins.tei_annotator.config import TEI_NSMAP, get_annotators
from fastapi_app.plugins.tei_annotator.utils import call_annotate

logger = logging.getLogger(__name__)

MAX_ANNOTATION_RETRIES = 2

_xml_tag_re = re.compile(r"<[^>]+>")


async def run_annotation(
    element: etree._Element,
    annotator: BaseAnnotator,
    call_fn=call_annotate,
    max_retries: int = MAX_ANNOTATION_RETRIES,
) -> list[str]:
    """
    Annotate *element* using *annotator*, calling *call_fn* for LLM inference.

    Retries up to *max_retries* times if the webservice response drops content
    (detected by stripping XML tags and comparing with the original plain text).
    Falls back to serializing the original element unchanged if all retries fail.

    Returns a list of serialized XML fragment strings ready for the frontend to
    insert into the document.
    """
    from fastapi_app.lib.utils.xml_utils import apply_entity_encoding_from_config

    plain_text = annotator.get_plain_text(element)
    plain_text_stripped = plain_text.rstrip(' \t')
    new_items: list[etree._Element | str] = [element]

    for attempt in range(max_retries + 1):
        result = await call_fn(
            text=plain_text,
            schema=annotator.get_schema(),
            provider=annotator.provider,
            model=annotator.model,
        )
        annotated_xml = result.get("xml", "")
        annotated_plain = _xml_tag_re.sub("", annotated_xml).rstrip(' \t')

        if annotated_plain == plain_text_stripped:
            new_items = annotator.apply_result(element, annotated_xml)
            break

        if attempt < max_retries:
            logger.warning(
                "tei-annotator: attempt %d/%d content mismatch, retrying "
                "(len plain=%d len result=%d)",
                attempt + 1,
                max_retries + 1,
                len(plain_text_stripped),
                len(annotated_plain),
            )
        else:
            logger.warning(
                "tei-annotator: all %d attempts failed content validation; returning original element",
                max_retries + 1,
            )

    return [
        strip_namespaces(
            apply_entity_encoding_from_config(
                item if isinstance(item, str) else
                etree.tostring(item, encoding="unicode", xml_declaration=False,
                               with_tail=(item is not element))
            )
        )
        for item in new_items
    ]

router = APIRouter(prefix="/api/plugins/tei-annotator", tags=["tei-annotator"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class AnnotateRequest(BaseModel):
    stable_id: str
    xpath: str
    annotator_id: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _authenticate(
    session_id_value: str | None,
    session_manager,
    auth_manager,
):
    """Validate session and return user dict. Raises HTTPException on failure."""
    from fastapi_app.config import get_settings

    if not session_id_value:
        raise HTTPException(status_code=401, detail="Authentication required")

    settings = get_settings()
    if not session_manager.is_session_valid(session_id_value, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Invalid or expired session")

    user = auth_manager.get_user_by_session_id(session_id_value, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return user


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/annotators")
async def list_annotators(
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
):
    """Return metadata for all registered annotators."""
    _authenticate(x_session_id or session_id, session_manager, auth_manager)
    return [
        {
            "id": ann.id,
            "display_name": ann.display_name,
            "description": ann.description,
            "target_tag": ann.target_tag,
        }
        for ann in get_annotators()
    ]


@router.post("/annotate")
async def annotate(
    body: AnnotateRequest,
    session_id: str | None = Query(None),
    x_session_id: str | None = Header(None, alias="X-Session-ID"),
    session_manager=Depends(get_session_manager),
    auth_manager=Depends(get_auth_manager),
    db=Depends(get_db),
    file_storage=Depends(get_file_storage),
):
    """
    Annotate a single XML element selected by XPath in the given document.

    Returns the full modified document as an XML string, ready for the merge/diff view.
    """
    from fastapi_app.lib.repository.file_repository import FileRepository

    _authenticate(x_session_id or session_id, session_manager, auth_manager)

    # Resolve annotator
    annotator = get_annotator(body.annotator_id)
    if annotator is None:
        raise HTTPException(status_code=404, detail=f"Unknown annotator: {body.annotator_id!r}")

    # Load document
    file_repo = FileRepository(db)
    file_meta = file_repo.get_file_by_id_or_stable_id(body.stable_id)
    if file_meta is None:
        raise HTTPException(status_code=404, detail=f"File not found: {body.stable_id!r}")

    xml_bytes = file_storage.read_file(file_meta.id, "tei")
    try:
        root = etree.fromstring(xml_bytes)
    except etree.XMLSyntaxError as exc:
        raise HTTPException(status_code=422, detail=f"Could not parse XML: {exc}") from exc

    # Find the target element
    try:
        matches: Any = root.xpath(body.xpath, namespaces=TEI_NSMAP)
    except etree.XPathEvalError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid XPath: {exc}") from exc

    if not matches:
        raise HTTPException(
            status_code=404,
            detail=f"No element found at XPath: {body.xpath!r}",
        )

    element = matches[0]
    if not isinstance(element, etree._Element):
        raise HTTPException(status_code=400, detail="XPath must select an element node")

    local_name = etree.QName(element.tag).localname
    if local_name != annotator.target_tag:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Annotator '{annotator.id}' targets <{annotator.target_tag}> "
                f"but XPath selected <{local_name}>"
            ),
        )

    fragments = await run_annotation(element, annotator)
    return {"fragments": fragments}
