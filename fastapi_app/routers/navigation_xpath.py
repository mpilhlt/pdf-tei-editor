"""
Navigation XPath API: the XPath expressions of the node navigation in the XML editor statusbar.

The entries are stored in `data/db/navigation_xpath.json` (see `fastapi_app/lib/utils/navigation_xpath.py`).
The defaults of the extractors are merged in on every read and cannot be changed; annotators, reviewers and
admins can add their own entries per variant.
"""

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..config import get_settings
from ..lib.core.dependencies import require_annotator_reviewer_or_admin, require_authenticated_user
from ..lib.extraction import list_extractors
from ..lib.models.models_navigation_xpath import (
    NavigationXpathItem,
    NavigationXpathResponse,
    SaveNavigationXpathRequest,
    VariantNavigationXpathResponse,
)
from ..lib.utils.navigation_xpath import InvalidXpathError, load_navigation_xpath, save_custom_entries

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/navigation-xpath", tags=["navigation-xpath"])


def get_extractors() -> list[dict[str, Any]]:
    """The infos of the available extractors (dependency, so tests can replace it)."""
    return list_extractors(available_only=True)


@router.get("", response_model=NavigationXpathResponse)
def list_navigation_xpath(
    current_user: dict[str, Any] = Depends(require_authenticated_user),
    extractors: list[dict[str, Any]] = Depends(get_extractors),
) -> NavigationXpathResponse:
    """The navigation XPath entries of all variants: the extractor defaults first, then the user entries."""
    data = load_navigation_xpath(get_settings().db_dir, extractors)
    return NavigationXpathResponse(
        variants={variant: [NavigationXpathItem(**entry) for entry in entries] for variant, entries in data.items()}
    )


@router.put("/{variant}", response_model=VariantNavigationXpathResponse)
def save_navigation_xpath(
    variant: str,
    request: SaveNavigationXpathRequest,
    current_user: dict[str, Any] = Depends(require_annotator_reviewer_or_admin),
    extractors: list[dict[str, Any]] = Depends(get_extractors),
) -> VariantNavigationXpathResponse:
    """Replace the user entries of a variant. The extractor defaults are kept and cannot be changed.

    Returns 404 if no extractor supports the variant and 422 if an expression is invalid, entered twice or
    one of the defaults.
    """
    variants = {v for extractor in extractors for v in (extractor.get("variants") or [])}
    if variant not in variants:
        raise HTTPException(status_code=404, detail=f"Unknown variant: {variant}")
    try:
        entries = save_custom_entries(
            get_settings().db_dir, extractors, variant, [(e.value, e.label) for e in request.entries]
        )
    except InvalidXpathError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    logger.info(f"User {current_user.get('username')} saved {len(request.entries)} navigation XPath entries of variant {variant}")
    return VariantNavigationXpathResponse(variant=variant, entries=[NavigationXpathItem(**entry) for entry in entries])
