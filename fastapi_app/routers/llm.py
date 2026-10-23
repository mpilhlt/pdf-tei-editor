"""
LLM provider router.

Exposes the registered LLM provider connectors (fastapi_app/lib/llm/) for
any frontend consumer to list - e.g. the default-model picker and the
annotation-review plugin (both in later plans). Modeled directly on
fastapi_app/routers/extraction.py's GET /extract/list route.
"""

import logging
from typing import Any, Literal

import requests
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ..lib.core.dependencies import require_admin_user, require_authenticated_user
from ..lib.llm import LLMProviderError, LLMProviderRegistry, get_default_model, is_model_allowed, set_default_model
from ..lib.secrets import MissingSecretError, SecretsError, secret_required_detail
from ..lib.llm.model_access import is_free_model, user_may_use_model

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
    free: bool


class ProviderResponse(BaseModel):
    id: str
    label: str
    models: list[ModelResponse]
    # True if the provider needs the user's own API key and none is stored yet (models is then empty)
    key_required: bool = False
    # The secret service the key belongs to, for the frontend's key prompt
    secret_service: str | None = None
    # Why the provider's models could not be listed (models is then empty)
    error: str | None = None


# Longest provider error message passed on to the frontend
MAX_ERROR_LENGTH = 300


@router.get("/providers", response_model=list[ProviderResponse])
def list_providers(
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> list[ProviderResponse]:
    """List available LLM providers and their models.

    A provider whose list_models() call fails (network error, rejected key,
    malformed response, etc.) or whose stored user key cannot be decrypted
    is listed with an `error` and no models rather than failing the whole
    request - other providers should still be listed, and the user should
    see why one has no models. Models rejected by the
    admin-configured `llm.model-filter.include`/`.exclude` filters (see
    fastapi_app/lib/llm/model_filter.py) are silently omitted rather than
    returned with a flag - the picker should simply never offer them.
    Models the current user may not use (non-free models for non-admins,
    except the default - see fastapi_app/lib/llm/model_access.py) are
    omitted the same way.

    Providers without a shared key use the current user's stored key; when
    there is none, the provider is listed with `key_required` and no models
    so the frontend can offer to add the key.
    """
    result: list[ProviderResponse] = []
    registry = LLMProviderRegistry.get_instance()
    for registered in registry.list_providers(available_only=True):
        try:
            provider = registry.get_provider_for_user(registered.id, current_user.get("username"))
        except MissingSecretError:
            result.append(ProviderResponse(
                id=registered.id, label=registered.label, models=[], key_required=True,
                secret_service=registered.secret_service,
            ))
            continue
        except SecretsError as e:
            logger.warning(f"Cannot use the stored key of '{current_user.get('username')}' for LLM provider '{registered.id}': {e}")
            result.append(ProviderResponse(
                id=registered.id, label=registered.label, models=[], secret_service=registered.secret_service,
                error="Your stored API key cannot be decrypted. Please enter it again.",
            ))
            continue
        try:
            models = provider.list_models()
        except Exception as e:
            logger.warning(f"LLM provider '{provider.id}' has no models - list_models() failed: {e}")
            result.append(ProviderResponse(
                id=provider.id, label=provider.label, models=[], secret_service=provider.secret_service,
                error=f"Could not list models: {e}"[:MAX_ERROR_LENGTH],
            ))
            continue
        visible_models = [
            ModelResponse(
                id=model["id"],
                label=model["label"],
                capabilities=sorted(model["capabilities"]),
                free=is_free_model(provider, model),
                status=(
                    ModelStatusResponse(**model["status"])
                    if model["status"] is not None
                    else None
                ),
            )
            for model in models
            if is_model_allowed(f"{provider.label}/{model['label']}")
            and user_may_use_model(provider, model, current_user)
        ]
        result.append(ProviderResponse(
            id=provider.id, label=provider.label, models=visible_models, secret_service=provider.secret_service,
        ))
    return result


class DefaultModelResponse(BaseModel):
    provider_id: str
    model_id: str


@router.get("/default-model", response_model=DefaultModelResponse | None)
def get_default(
    current_user: dict[str, Any] = Depends(require_authenticated_user),
) -> DefaultModelResponse | None:
    """The installation-wide default model set by an admin, or null if none is set."""
    default = get_default_model()
    return DefaultModelResponse(provider_id=default[0], model_id=default[1]) if default else None


@router.put("/default-model", response_model=DefaultModelResponse)
def set_default(
    body: DefaultModelResponse,
    current_user: dict[str, Any] = Depends(require_admin_user),
) -> DefaultModelResponse:
    """Set the installation-wide default model (admin only). The model must exist and pass the model filter."""
    try:
        provider = LLMProviderRegistry.get_instance().get_provider_for_user(body.provider_id, current_user.get("username"))
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except MissingSecretError as e:
        raise HTTPException(status_code=428, detail=secret_required_detail(e)) from e
    try:
        models = provider.list_models()
    except (requests.RequestException, RuntimeError, LLMProviderError) as e:
        raise HTTPException(status_code=502, detail=f"Could not list models of '{provider.label}': {e}") from e
    model = next((m for m in models if m["id"] == body.model_id), None)
    if model is None:
        raise HTTPException(status_code=404, detail=f"Unknown model '{body.model_id}' for provider '{provider.label}'")
    if not is_model_allowed(f"{provider.label}/{model['label']}"):
        raise HTTPException(status_code=403, detail="This model is excluded by the configured model filter")
    try:
        set_default_model(body.provider_id, body.model_id)
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    logger.info(f"User {current_user.get('username')} set the default LLM model to {body.provider_id}/{body.model_id}")
    return body
