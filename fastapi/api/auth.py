from fastapi import APIRouter, HTTPException, Request, Depends
from http import HTTPStatus
from pydantic import BaseModel
from typing import Optional, Dict, Any
from uuid import uuid4
import logging

from ..config import settings
from ..lib.auth import AuthManager
from ..lib.server_utils import get_session_id_from_request

logger = logging.getLogger(__name__)

# Pydantic models
class LoginRequest(BaseModel):
    username: str
    passwd_hash: str

class LoginResponse(BaseModel):
    username: str
    fullname: Optional[str] = None
    sessionId: str

class LogoutResponse(BaseModel):
    status: str = "logged_out"

class StatusResponse(BaseModel):
    username: str
    fullname: Optional[str] = None

class ErrorResponse(BaseModel):
    error: str

# Create router
router = APIRouter(prefix="/api/auth", tags=["auth"])

# Dependency to get auth manager
def get_auth_manager() -> AuthManager:
    return AuthManager(settings.DB_DIR)

@router.post("/login", response_model=LoginResponse)
async def login(request: LoginRequest, auth_manager: AuthManager = Depends(get_auth_manager)):
    """Logs a user in by verifying credentials and creating a new session."""

    if not request.username or not request.passwd_hash:
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail="Missing username or password hash."
        )

    if auth_manager.verify_password(request.username, request.passwd_hash):
        # Clean up expired sessions before creating a new one
        auth_manager.cleanup_expired_sessions()

        # Generate new session ID server-side
        session_id = str(uuid4())

        if auth_manager.create_user_session(request.username, session_id):
            user_data = auth_manager.get_user_by_session_id(session_id)
            if user_data:
                return LoginResponse(
                    username=user_data["username"],
                    fullname=user_data.get("fullname"),
                    sessionId=session_id
                )
            else:
                raise HTTPException(
                    status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                    detail="Failed to retrieve user data."
                )
        else:
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                detail="Failed to create session."
            )
    else:
        raise HTTPException(
            status_code=HTTPStatus.UNAUTHORIZED,
            detail="Invalid credentials."
        )

@router.post("/logout", response_model=LogoutResponse)
async def logout(request: Request, auth_manager: AuthManager = Depends(get_auth_manager)):
    """Logs a user out by deleting their session."""
    session_id = get_session_id_from_request(request)
    if session_id:
        auth_manager.delete_user_session(session_id)
    return LogoutResponse()

@router.get("/status", response_model=StatusResponse)
async def status(request: Request, auth_manager: AuthManager = Depends(get_auth_manager)):
    """Checks the current user's login status and refreshes session."""
    session_id = get_session_id_from_request(request)
    user = auth_manager.get_user_by_session_id(session_id)
    if user:
        # Refresh session access time
        auth_manager.update_session_access_time(session_id)
        return StatusResponse(
            username=user["username"],
            fullname=user.get("fullname")
        )
    else:
        raise HTTPException(
            status_code=HTTPStatus.UNAUTHORIZED,
            detail="Not authenticated."
        )