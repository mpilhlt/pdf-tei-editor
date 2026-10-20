"""
User secrets router: API keys users store for services that bill them (see fastapi_app/lib/secrets/).

Values are write-only: they are accepted here but never returned. Plugins read them
with ``require_user_secret()`` on behalf of the user.
"""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..lib.core.dependencies import require_authenticated_user
from ..lib.secrets import SecretServiceRegistry, SecretStore, SecretsError, get_secret_store

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/secrets", tags=["secrets"])


class SecretServiceResponse(BaseModel):
    """A service that needs a user-supplied secret, and whether the current user has stored one."""

    id: str
    label: str
    description: str
    help_url: str
    is_set: bool


class SecretValueRequest(BaseModel):
    """The secret to store."""

    value: Annotated[str, Field(min_length=1, max_length=4096)]


def _username(user: dict) -> str:
    return user["username"]


@router.get("", response_model=list[SecretServiceResponse])
def list_secret_services(
    user: dict = Depends(require_authenticated_user),
    store: SecretStore = Depends(get_secret_store),
) -> list[SecretServiceResponse]:
    """List the services that need a user secret, with `is_set` for the current user."""
    stored = set(store.list_services(_username(user)))
    return [
        SecretServiceResponse(
            id=s.id, label=s.label, description=s.description, help_url=s.help_url, is_set=s.id in stored
        )
        for s in SecretServiceRegistry.list()
    ]


@router.put("/{service}", response_model=SecretServiceResponse)
def set_secret(
    service: str,
    request: SecretValueRequest,
    user: dict = Depends(require_authenticated_user),
    store: SecretStore = Depends(get_secret_store),
) -> SecretServiceResponse:
    """Store the current user's secret for a registered service (replaces an existing one)."""
    info = SecretServiceRegistry.get(service)
    if info is None:
        raise HTTPException(status_code=404, detail=f"Unknown service: {service}")
    try:
        store.set(_username(user), service, request.value.strip())
    except (ValueError, SecretsError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    return SecretServiceResponse(id=info.id, label=info.label, description=info.description, help_url=info.help_url, is_set=True)


@router.delete("/{service}", response_model=SecretServiceResponse)
def delete_secret(
    service: str,
    user: dict = Depends(require_authenticated_user),
    store: SecretStore = Depends(get_secret_store),
) -> SecretServiceResponse:
    """Remove the current user's secret for a service."""
    info = SecretServiceRegistry.describe(service)
    store.delete(_username(user), service)
    return SecretServiceResponse(id=info.id, label=info.label, description=info.description, help_url=info.help_url, is_set=False)
