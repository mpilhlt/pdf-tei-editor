"""
Custom routes for the annotation-review plugin.

Provides:
  POST /api/plugins/annotation-review/review — review a document's
  annotations against its own editorialDecl rules and return validated
  findings.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from fastapi_app.config import get_settings
from fastapi_app.lib.core.dependencies import require_authenticated_user
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.llm import LLMProviderRegistry
from fastapi_app.plugins.annotation_review.review_logic import (
    NoRuleExcerptsError,
    run_review,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/plugins/annotation-review", tags=["annotation-review"])


class ReviewRequest(BaseModel):
    xml: str
    provider_id: str
    model_id: str


class FindingResponse(BaseModel):
    id: int
    old: str
    new: str
    rationale: str


class ReviewResponse(BaseModel):
    findings: list[FindingResponse]


@router.post("/review", response_model=ReviewResponse)
async def review(
    body: ReviewRequest,
    current_user: dict = Depends(require_authenticated_user),
) -> ReviewResponse:
    """
    Review the given (possibly unsaved) document content against its own
    editorialDecl rules, using the given provider/model.
    """
    try:
        provider = LLMProviderRegistry.get_instance().get_provider(body.provider_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    cache = UrlCache(get_settings().annotation_rules_cache_dir)

    try:
        findings = await run_review(body.xml, provider, body.model_id, cache)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except NoRuleExcerptsError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    return ReviewResponse(findings=[FindingResponse(**f) for f in findings])
