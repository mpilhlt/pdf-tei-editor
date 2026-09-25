"""
LLM provider router.

Exposes the registered LLM provider connectors (fastapi_app/lib/llm/) for
any frontend consumer to list - e.g. the default-model picker and the
annotation-review plugin (both in later plans). Modeled directly on
fastapi_app/routers/extraction.py's GET /extract/list route.
"""

import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..lib.core.dependencies import require_authenticated_user
from ..lib.llm import LLMProviderRegistry, is_model_allowed

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/llm", tags=["llm"])


class ModelStatusResponse(BaseModel):
    availability: Literal["available", "busy", "very_busy"]
    detail: str


class ModelResponse(BaseModel):
    id: str
    label: str
    capabilities: list[str]
    status: ModelStatusResponse | None


class ProviderResponse(BaseModel):
    id: str
    label: str
    models: list[ModelResponse]


@router.get("/providers", response_model=list[ProviderResponse])
def list_providers(
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> list[ProviderResponse]:
    """List available LLM providers and their models.

    A provider whose list_models() call fails (network error, malformed
    response, etc.) is skipped rather than failing the whole request -
    other providers should still be listed. Models rejected by the
    admin-configured `llm.model-filter` allow-list (see
    fastapi_app/lib/llm/model_filter.py) are silently omitted rather than
    returned with a flag - the picker should simply never offer them.
    """
    result: list[ProviderResponse] = []
    for provider in LLMProviderRegistry.get_instance().list_providers(available_only=True):
        try:
            models = provider.list_models()
        except Exception as e:
            logger.warning(f"Skipping LLM provider '{provider.id}' - list_models() failed: {e}")
            continue
        result.append(
            ProviderResponse(
                id=provider.id,
                label=provider.label,
                models=[
                    ModelResponse(
                        id=model["id"],
                        label=model["label"],
                        capabilities=sorted(model["capabilities"]),
                        status=(
                            ModelStatusResponse(**model["status"])
                            if model["status"] is not None
                            else None
                        ),
                    )
                    for model in models
                    if is_model_allowed(f"{provider.label}/{model['label']}")
                ],
            )
        )
    return result
