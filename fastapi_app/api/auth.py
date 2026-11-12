"""
Authentication API endpoints for FastAPI.

Provides login (with a password or a personal access token), logout, and session status checking.
"""

from typing import Any, Optional, List
from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends, Header, Request, HTTPException, Response
from starlette.concurrency import run_in_threadpool

from ..lib.core.access_tokens import AccessTokenStore, get_access_token_store
from ..lib.core.login_rate_limit import check_login_allowed, client_ip, login_rate_limiter

from ..config import get_settings
from ..lib.utils.auth import AuthManager
from ..lib.core.sessions import SessionManager
from ..lib.utils.server_utils import get_session_id_from_request
from ..lib.utils.logging_utils import get_logger
from ..lib.plugins.plugin_window_auth import PLUGIN_ROUTES_PREFIX, PLUGIN_SESSION_COOKIE


logger = get_logger(__name__)
router = APIRouter(prefix="/auth", tags=["authentication"])


# Pydantic Models

class LoginRequest(BaseModel):
    """Request model for user login. Send the plain text password; HTTPS protects it in transit."""
    username: str
    password: Optional[str] = None
    passwd_hash: Optional[str] = Field(None, description="Removed: the SHA-256 hash of the password is no longer accepted. Send `password` instead.")


class TokenLoginRequest(BaseModel):
    """Request model for token login with the token in the body instead of the Authorization header"""
    token: str


class LoginResponse(BaseModel):
    """Response model for successful login"""
    username: str
    fullname: Optional[str] = None
    roles: Optional[List[str]] = None
    sessionId: str


class StatusResponse(BaseModel):
    """Response model for session status"""
    username: str
    fullname: Optional[str] = None
    roles: Optional[List[str]] = None


class LogoutResponse(BaseModel):
    """Response model for logout"""
    status: str


# Helper function to get dependencies

def get_auth_manager() -> AuthManager:
    """Get AuthManager instance with settings"""
    settings = get_settings()
    return AuthManager(settings.db_dir, logger=logger)


def get_session_manager() -> SessionManager:
    """Get SessionManager instance with settings"""
    settings = get_settings()
    return SessionManager(settings.db_dir, logger=logger)


# API Endpoints

@router.post("/login", response_model=LoginResponse)
async def login(request_data: LoginRequest, request: Request):
    """
    Authenticate user and create session.

    Returns user data and session ID for client to store in state.
    """
    if request_data.passwd_hash is not None and request_data.password is None:
        raise HTTPException(status_code=400, detail="Login with a password hash (passwd_hash) is no longer supported: send the plain text password as 'password', or log in with an access token at /api/v1/auth/token-login")
    if not request_data.username or not request_data.password:
        raise HTTPException(status_code=400, detail="Missing username or password")

    auth_manager = get_auth_manager()
    session_manager = get_session_manager()

    rate_key = f"password:{client_ip(request)}:{request_data.username}"
    check_login_allowed(rate_key)

    # Verify credentials
    # scrypt takes tens of milliseconds of CPU time, so keep it off the event loop
    user = await run_in_threadpool(auth_manager.verify_password, request_data.username, request_data.password)
    if not user:
        login_rate_limiter.record_failure(rate_key)
        raise HTTPException(status_code=401, detail="Invalid credentials")
    login_rate_limiter.reset(rate_key)

    # Clean up expired sessions (using default timeout from config)
    settings = get_settings()
    session_manager.cleanup_expired_sessions(settings.session_timeout)

    # Create new session
    session_id = session_manager.create_session(request_data.username)

    logger.info(f"User {request_data.username} logged in with session {session_id[:8]}...")

    return _login_response(user, session_id)


def _login_response(user: dict[str, Any], session_id: str) -> LoginResponse:
    """Build the login response, normalizing the legacy single "role" field."""
    roles = user.get("roles")
    if roles is None:
        role = user.get("role")
        roles = [role] if role else []
    return LoginResponse(
        username=user["username"],
        fullname=user.get("fullname"),
        roles=roles,
        sessionId=session_id,
    )


@router.post("/token-login", response_model=LoginResponse)
async def token_login(
    request: Request,
    body: Optional[TokenLoginRequest] = None,
    authorization: Optional[str] = Header(None),
    token_store: AccessTokenStore = Depends(get_access_token_store),
) -> LoginResponse:
    """
    Exchange a personal access token for a session.

    Send the token as `Authorization: Bearer pte_...` (preferred) or as `{"token": "pte_..."}` in the
    body. Returns the same response as `/auth/login`; use the session ID as `X-Session-ID` in later
    requests. The session ends when the token is revoked or expires, or after the usual inactivity timeout.
    """
    rate_key = f"token:{client_ip(request)}"
    check_login_allowed(rate_key)

    scheme, _, header_token = (authorization or "").partition(" ")
    token = header_token.strip() if scheme.lower() == "bearer" else ""
    if not token and body is not None:
        token = body.token.strip()
    if not token:
        raise HTTPException(
            status_code=401,
            detail="Missing access token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    info = token_store.verify(token)
    user = get_auth_manager().get_user_by_username(info["username"]) if info else None
    if info is None or user is None:
        login_rate_limiter.record_failure(rate_key)
        raise HTTPException(
            status_code=401,
            detail="Invalid, expired or revoked access token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    session_manager = get_session_manager()
    settings = get_settings()
    session_manager.cleanup_expired_sessions(settings.session_timeout)
    session_id = session_manager.create_session(
        info["username"], token_id=info["token_id"], expires_at=info["expires_at"]
    )

    logger.info(
        f"User {info['username']} logged in with access token {info['token_id']} ('{info['label']}'), "
        f"session {session_id[:8]}..."
    )

    return _login_response(user, session_id)


@router.post("/logout", response_model=LogoutResponse)
async def logout(request: Request, response: Response):
    """
    Logout user by deleting their session.

    Also clears the cookie that authenticates backend plugin pages. Returns success even if no session exists.
    """
    session_id = get_session_id_from_request(request)
    response.delete_cookie(PLUGIN_SESSION_COOKIE, path=PLUGIN_ROUTES_PREFIX, httponly=True, samesite="strict")

    if session_id:
        session_manager = get_session_manager()
        session_manager.delete_session(session_id)
        logger.info(f"User logged out, deleted session {session_id[:8]}...")

    return LogoutResponse(status="logged_out")


@router.get("/status", response_model=StatusResponse)
async def status(request: Request):
    """
    Check current user's authentication status.

    Refreshes session access time if valid.
    """
    session_id = get_session_id_from_request(request)

    if not session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    auth_manager = get_auth_manager()
    session_manager = get_session_manager()
    settings = get_settings()

    # Validate session
    if not session_manager.is_session_valid(session_id, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Session expired")

    # Get user data
    user = auth_manager.get_user_by_session_id(session_id, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Refresh session
    session_manager.update_session_access_time(session_id)

    # Normalize roles field (legacy data may have "role" as string)
    roles = user.get("roles")
    if roles is None:
        # Handle legacy "role" field (singular string)
        role = user.get("role")
        roles = [role] if role else []

    return StatusResponse(
        username=user["username"],
        fullname=user.get("fullname"),
        roles=roles
    )
