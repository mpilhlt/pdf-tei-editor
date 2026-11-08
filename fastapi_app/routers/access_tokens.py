"""
Personal access tokens router: create, list and revoke tokens for API authentication.

Implements:
- GET /api/v1/auth/tokens - Tokens the current user may see
- POST /api/v1/auth/tokens - Create a token (reviewer or admin)
- DELETE /api/v1/auth/tokens/{token_id} - Revoke a token
- GET /api/v1/auth/tokens/eligible-users - Users the current user may create tokens for

The exchange of a token for a session is ``POST /api/v1/auth/token-login`` in ``api/auth.py``.
Permissions are defined in ``lib/permissions/access_token_permissions.py``.
"""

import time
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..config import get_settings
from ..lib.core.access_tokens import (
    AccessTokenDict,
    AccessTokenStore,
    get_access_token_store,
    is_token_expired,
    revoke_token,
)
from ..lib.core.dependencies import (
    get_session_manager,
    require_authenticated_user,
    require_reviewer_or_admin,
)
from ..lib.core.sessions import SessionManager
from ..lib.permissions.access_token_permissions import (
    can_create_token_for,
    can_manage_token,
    is_admin,
)
from ..lib.permissions.user_utils import find_user, list_users
from ..lib.utils.config_utils import get_config
from ..lib.utils.logging_utils import get_logger

logger = get_logger(__name__)
router = APIRouter(prefix="/auth/tokens", tags=["authentication"])

UserDict = dict[str, Any]

DEFAULT_EXPIRY_DAYS = 90
DEFAULT_MAX_DAYS = 365


class AccessTokenInfo(BaseModel):
    """Metadata of a personal access token (never the token itself)."""

    token_id: str = Field(..., description="Public id of the token, part of the token string")
    label: str
    username: str = Field(..., description="The user the token authenticates as")
    created_by: str = Field(..., description="The user who created the token")
    created_at: float = Field(..., description="Epoch seconds")
    expires_at: Optional[float] = Field(None, description="Epoch seconds; null if the token does not expire")
    last_used_at: Optional[float] = Field(None, description="Epoch seconds of the last token login")
    expired: bool


class CreateAccessTokenRequest(BaseModel):
    """Parameters of a new token."""

    label: Annotated[str, Field(min_length=1, max_length=100)]
    username: Optional[str] = Field(None, description="The user the token authenticates as (default: the current user)")
    expires_in_days: Optional[int] = Field(
        DEFAULT_EXPIRY_DAYS,
        ge=1,
        description="Days until the token expires; null for no expiry (admins only, if auth.access-tokens.allow-no-expiry is true)",
    )


class CreateAccessTokenResponse(BaseModel):
    """A new token. `token` is shown only in this response."""

    token: str
    info: AccessTokenInfo


class EligibleUser(BaseModel):
    """A user the current user may create tokens for."""

    username: str
    fullname: Optional[str] = None


class RevokeAccessTokenResponse(BaseModel):
    """The result of revoking a token."""

    revoked: bool


def _to_info(token: AccessTokenDict) -> AccessTokenInfo:
    return AccessTokenInfo(
        token_id=token["token_id"],
        label=token["label"],
        username=token["username"],
        created_by=token["created_by"],
        created_at=token["created_at"],
        expires_at=token["expires_at"],
        last_used_at=token["last_used_at"],
        expired=is_token_expired(token),
    )


@router.get("", response_model=list[AccessTokenInfo])
def list_access_tokens(
    user: UserDict = Depends(require_authenticated_user),
    store: AccessTokenStore = Depends(get_access_token_store),
) -> list[AccessTokenInfo]:
    """
    List the tokens the current user may see and revoke: all tokens for admins, otherwise the tokens
    that authenticate as the current user and those the current user created. Revoked tokens are not listed.
    """
    return [_to_info(t) for t in store.list_tokens() if can_manage_token(user, t)]


@router.get("/eligible-users", response_model=list[EligibleUser])
def list_eligible_users(user: UserDict = Depends(require_reviewer_or_admin)) -> list[EligibleUser]:
    """List the users the current user may create tokens for (always including the current user)."""
    settings = get_settings()
    return [
        EligibleUser(username=u["username"], fullname=u.get("fullname"))
        for u in list_users(settings.db_dir)
        if u.get("username") and can_create_token_for(user, u)
    ]


@router.post("", response_model=CreateAccessTokenResponse)
def create_access_token(
    body: CreateAccessTokenRequest,
    user: UserDict = Depends(require_reviewer_or_admin),
    store: AccessTokenStore = Depends(get_access_token_store),
) -> CreateAccessTokenResponse:
    """
    Create a token. The full token is returned only in this response.

    Reviewers may create tokens for themselves and for users whose roles are a subset of their own,
    admins for any user. Changes made with a token are attributed to the token's user.
    """
    settings = get_settings()
    config = get_config()
    target_name = body.username or user["username"]
    target = find_user(target_name, list_users(settings.db_dir))
    if target is None:
        raise HTTPException(status_code=404, detail=f"User '{target_name}' not found")
    if not can_create_token_for(user, target):
        raise HTTPException(status_code=403, detail=f"You may not create access tokens for '{target_name}'")

    admin = is_admin(user)
    if body.expires_in_days is None:
        if not admin or not config.get("auth.access-tokens.allow-no-expiry", default=False):
            raise HTTPException(status_code=400, detail="Access tokens must have an expiry")
        expires_at = None
    else:
        max_days = int(config.get("auth.access-tokens.max-days", default=DEFAULT_MAX_DAYS))
        if not admin and body.expires_in_days > max_days:
            raise HTTPException(status_code=400, detail=f"Access tokens may be valid for at most {max_days} days")
        expires_at = time.time() + body.expires_in_days * 86400

    token, info = store.create(target_name, user["username"], body.label.strip(), expires_at)
    return CreateAccessTokenResponse(token=token, info=_to_info(info))


@router.delete("/{token_id}", response_model=RevokeAccessTokenResponse)
def revoke_access_token(
    token_id: str,
    user: UserDict = Depends(require_authenticated_user),
    store: AccessTokenStore = Depends(get_access_token_store),
    session_manager: SessionManager = Depends(get_session_manager),
) -> RevokeAccessTokenResponse:
    """Revoke a token and end the sessions created from it."""
    token = store.get(token_id)
    if token is None or not can_manage_token(user, token):
        raise HTTPException(status_code=404, detail="Access token not found")
    revoked = revoke_token(store, session_manager, token_id)
    logger.info(f"Access token {token_id} revoked by {user['username']}")
    return RevokeAccessTokenResponse(revoked=revoked)
