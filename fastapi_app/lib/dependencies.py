"""
FastAPI dependency injection functions.

Provides injectable dependencies for database, repositories, storage, auth, etc.
"""

from typing import Optional, Dict
from fastapi import Request, HTTPException, Depends
from functools import wraps

from ..config import get_settings
from .database import DatabaseManager
from .file_repository import FileRepository
from .file_storage import FileStorage
from .sessions import SessionManager
from .auth import AuthManager
from .server_utils import get_session_id_from_request
from .logging_utils import get_logger


logger = get_logger(__name__)


# Database dependencies

def get_db() -> DatabaseManager:
    """Get DatabaseManager instance"""
    settings = get_settings()
    db_path = settings.db_dir / "metadata.db"
    return DatabaseManager(db_path)


def get_file_repository(db: DatabaseManager = Depends(get_db)) -> FileRepository:
    """Get FileRepository instance with database"""
    return FileRepository(db)


def get_file_storage() -> FileStorage:
    """Get FileStorage instance with reference counting support"""
    settings = get_settings()
    storage_root = settings.data_root / "files"
    db_path = settings.db_dir / "metadata.db"
    return FileStorage(storage_root, db_path)


# Auth dependencies

def get_session_manager() -> SessionManager:
    """Get SessionManager instance"""
    settings = get_settings()
    return SessionManager(settings.db_dir, logger=logger)


def get_auth_manager() -> AuthManager:
    """Get AuthManager instance"""
    settings = get_settings()
    return AuthManager(settings.db_dir, logger=logger)


# Session ID extraction

def get_session_id(request: Request) -> Optional[str]:
    """Get session ID from request (if present)"""
    return get_session_id_from_request(request)


def require_session_id(request: Request) -> str:
    """Get session ID from request (raise if not present)"""
    session_id = get_session_id_from_request(request)
    if not session_id:
        raise HTTPException(status_code=401, detail="Session required")
    return session_id


# User dependencies

def get_current_user(
    request: Request,
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager)
) -> Optional[Dict]:
    """
    Get current authenticated user (returns None if not authenticated).
    Does not raise errors - use for optional authentication.
    """
    session_id = get_session_id_from_request(request)
    if not session_id:
        return None

    settings = get_settings()
    if not session_manager.is_session_valid(session_id, settings.session_timeout):
        return None

    user = auth_manager.get_user_by_session_id(session_id, session_manager)
    return user


def require_authenticated_user(
    request: Request,
    session_manager: SessionManager = Depends(get_session_manager),
    auth_manager: AuthManager = Depends(get_auth_manager)
) -> Dict:
    """
    Get current authenticated user (raises 401 if not authenticated).
    Use for endpoints that require authentication.
    """
    session_id = get_session_id_from_request(request)
    if not session_id:
        raise HTTPException(status_code=401, detail="Authentication required")

    settings = get_settings()
    if not session_manager.is_session_valid(session_id, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Session expired")

    user = auth_manager.get_user_by_session_id(session_id, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")

    # Refresh session
    session_manager.update_session_access_time(session_id)

    return user


# Decorator for requiring session (used on router functions)

def require_session(func):
    """
    Decorator to require valid session on endpoint.
    Can be used as @require_session before @router.post/get/etc.
    """
    @wraps(func)
    async def wrapper(*args, **kwargs):
        # Check if request is in kwargs
        request = kwargs.get('request')
        if not request:
            raise HTTPException(status_code=500, detail="Request not found in endpoint")

        session_id = get_session_id_from_request(request)
        if not session_id:
            raise HTTPException(status_code=401, detail="Session required")

        # Validate session
        session_manager = get_session_manager()
        settings = get_settings()
        if not session_manager.is_session_valid(session_id, settings.session_timeout):
            raise HTTPException(status_code=401, detail="Session expired")

        return await func(*args, **kwargs)

    return wrapper
