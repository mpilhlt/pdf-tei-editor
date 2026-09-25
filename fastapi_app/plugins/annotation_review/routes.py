"""
Custom routes for the annotation-review plugin.

Provides:
  POST /api/plugins/annotation-review/review — review a document's
  annotations against its own editorialDecl rules and return validated
  findings.
"""

from __future__ import annotations

import logging

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from fastapi_app.config import get_settings
from fastapi_app.lib.core.dependencies import require_authenticated_user
from fastapi_app.lib.core.url_cache import UrlCache
from fastapi_app.lib.llm import LLMProviderError, LLMProviderRegistry
from fastapi_app.lib.llm.model_access import ModelAccessDenied, check_model_access
from fastapi_app.plugins.annotation_review.prompts import UnusableResponseError
from fastapi_app.plugins.annotation_review.review_logic import (
    NoRuleExcerptsError,
    count_chunks,
    run_review,
)

logger = logging.getLogger(__name__)

def _upstream_error_message(error: requests.RequestException) -> str:
    """The provider's own error message if the failed response carries one, else the exception text."""
    if error.response is not None:
        try:
            message = error.response.json().get("error", {}).get("message")
        except (ValueError, AttributeError):
            message = None
        if isinstance(message, str) and message:
            return message
    return str(error)


router = APIRouter(prefix="/api/plugins/annotation-review", tags=["annotation-review"])


class ReviewRequest(BaseModel):
    xml: str
    provider_id: str
    model_id: str
    chunk_index: int = 0


class FindingResponse(BaseModel):
    id: int
    old: str
    new: str
    rationale: str


class ReviewResponse(BaseModel):
    findings: list[FindingResponse]
    chunk_count: int


class PlanRequest(BaseModel):
    xml: str


class PlanResponse(BaseModel):
    chunk_count: int


@router.post("/plan", response_model=PlanResponse)
async def plan(
    body: PlanRequest,
    current_user: dict = Depends(require_authenticated_user),
) -> PlanResponse:
    """Report how many chunks /review will need for the given document (no LLM call)."""
    try:
        return PlanResponse(chunk_count=count_chunks(body.xml))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.post("/review", response_model=ReviewResponse)
async def review(
    body: ReviewRequest,
    current_user: dict = Depends(require_authenticated_user),
) -> ReviewResponse:
    """
    Review one chunk of the given (possibly unsaved) document content against
    its own editorialDecl rules, using the given provider/model. The response
    reports how many chunks the document has; the client requests each
    chunk_index in turn.
    """
    try:
        provider = LLMProviderRegistry.get_instance().get_provider(body.provider_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e

    try:
        check_model_access(provider, body.model_id, current_user)
    except ModelAccessDenied as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    cache = UrlCache(get_settings().annotation_rules_cache_dir)

    try:
        findings, chunk_count = await run_review(body.xml, provider, body.model_id, cache, body.chunk_index)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except NoRuleExcerptsError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except UnusableResponseError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except LLMProviderError as e:
        logger.warning(f"annotation-review: provider '{body.provider_id}' failed: {e}")
        raise HTTPException(status_code=502, detail=f"LLM provider request failed: {e}") from e
    except requests.RequestException as e:
        logger.warning(f"annotation-review: provider '{body.provider_id}' request failed: {e}")
        raise HTTPException(status_code=502, detail=f"LLM provider request failed: {_upstream_error_message(e)}") from e

    return ReviewResponse(findings=[FindingResponse(**f) for f in findings], chunk_count=chunk_count)
