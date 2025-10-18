"""
Authentication API endpoints for FastAPI.

Provides login, logout, and session status checking.
"""

from typing import Optional, List
from pydantic import BaseModel
from fastapi import APIRouter, Request, HTTPException, Response
from fastapi.responses import JSONResponse

from ..config import get_settings
from ..lib.auth import AuthManager
from ..lib.sessions import SessionManager
from ..lib.server_utils import get_session_id_from_request
from ..lib.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/auth", tags=["authentication"])


# Pydantic Models

class LoginRequest(BaseModel):
    """Request model for user login"""
    username: str
    passwd_hash: str


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
    if not request_data.username or not request_data.passwd_hash:
        raise HTTPException(status_code=400, detail="Missing username or password hash")

    auth_manager = get_auth_manager()
    session_manager = get_session_manager()

    # Verify credentials
    user = auth_manager.verify_password(request_data.username, request_data.passwd_hash)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # Clean up expired sessions (using default timeout from config)
    settings = get_settings()
    session_manager.cleanup_expired_sessions(settings.session_timeout)

    # Create new session
    session_id = session_manager.create_session(request_data.username)

    # Build response
    response_data = {
        "username": user.get("username"),
        "fullname": user.get("fullname"),
        "roles": user.get("roles"),
        "sessionId": session_id
    }

    logger.info(f"User {request_data.username} logged in with session {session_id[:8]}...")

    return LoginResponse(**response_data)


@router.post("/logout", response_model=LogoutResponse)
async def logout(request: Request):
    """
    Logout user by deleting their session.

    Returns success even if no session exists.
    """
    session_id = get_session_id_from_request(request)

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

    return StatusResponse(
        username=user.get("username"),
        fullname=user.get("fullname"),
        roles=user.get("roles")
    )
