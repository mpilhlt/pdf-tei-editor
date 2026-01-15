"""
FastAPI dependency injection functions.

Provides injectable dependencies for database, repositories, storage, auth, etc.
"""

from typing import Optional, Dict
from fastapi import Request, HTTPException, Depends
from functools import wraps
import threading
from pathlib import Path

from ..config import get_settings
from .database import DatabaseManager
from .file_repository import FileRepository
from .file_storage import FileStorage
from .sessions import SessionManager
from .auth import AuthManager
from .server_utils import get_session_id_from_request
from .logging_utils import get_logger
from .sse_service import SSEService
from .sync_service import SyncService
from .event_bus import EventBus, get_event_bus


logger = get_logger(__name__)

# Global service instances (singletons)
_sse_service_instance: Optional[SSEService] = None
_db_manager_instance: Optional[DatabaseManager] = None
_session_manager_instance: Optional[SessionManager] = None
_auth_manager_instance: Optional[AuthManager] = None
_db_manager_lock = None  # Lazy init to avoid import-time issues


def _get_db_manager_lock():
    """Get the lock for database manager initialization"""
    global _db_manager_lock
    if _db_manager_lock is None:
        import threading
        _db_manager_lock = threading.Lock()
    return _db_manager_lock


# Database dependencies

class _DatabaseManagerSingleton:
    """
    Proper singleton implementation for DatabaseManager.
    
    This ensures only one DatabaseManager instance exists per database
    throughout the application lifecycle.
    """
    _instances: Dict[str, DatabaseManager] = {}
    _locks: Dict[str, threading.Lock] = {}
    _lock = threading.Lock()

    @classmethod
    def get_instance(cls, db_path: str) -> DatabaseManager:
        """
        Get or create a singleton DatabaseManager instance for the given database path.
        
        Args:
            db_path: Path to the database file
            
        Returns:
            DatabaseManager instance
        """
        with cls._lock:
            if db_path not in cls._instances:
                # Create lock for this specific database path
                cls._locks[db_path] = threading.Lock()
                
        # Get the lock for this specific database
        db_lock = cls._locks[db_path]
        
        with db_lock:
            # Double-check pattern
            if db_path not in cls._instances:
                settings = get_settings()
                logger.debug(f"Initializing database at {db_path}")
                # Convert string to Path object before passing to DatabaseManager
                cls._instances[db_path] = DatabaseManager(Path(db_path))
                logger.debug("Database initialized successfully")
            
            return cls._instances[db_path]

    @classmethod
    def reset_instances(cls) -> None:
        """
        Reset all singleton instances.
        
        This is primarily for testing purposes.
        """
        with cls._lock:
            cls._instances.clear()
            cls._locks.clear()


def get_db() -> DatabaseManager:
    """Get singleton DatabaseManager instance"""
    settings = get_settings()
    db_path = str(settings.db_dir / "metadata.db")
    return _DatabaseManagerSingleton.get_instance(db_path)


def reset_db_manager() -> None:
    """
    Reset the DatabaseManager singleton.

    This is primarily for testing purposes, to allow re-initialization
    after database files are deleted/recreated.
    """
    settings = get_settings()
    db_path = str(settings.db_dir / "metadata.db")
    _DatabaseManagerSingleton.reset_instances()
    
    from .storage_references import StorageReferenceManager
    StorageReferenceManager.reset_cache()

def get_file_repository(db: DatabaseManager = Depends(get_db)) -> FileRepository:
    """Get FileRepository instance with database"""
    return FileRepository(db)


def get_file_storage() -> FileStorage:
    """Get FileStorage instance with reference counting support"""
    settings = get_settings()
    storage_root = settings.data_root / "files"
    db_path = str(settings.db_dir / "metadata.db")
    db_manager = _DatabaseManagerSingleton.get_instance(db_path)
    return FileStorage(storage_root, db_manager)


# Auth dependencies

def get_session_manager() -> SessionManager:
    """Get SessionManager instance"""
    global _session_manager_instance
    if _session_manager_instance is None:
        settings = get_settings()
        _session_manager_instance = SessionManager(settings.db_dir, logger=logger)
    return _session_manager_instance


def get_auth_manager() -> AuthManager:
    """Get AuthManager instance"""
    global _auth_manager_instance
    if _auth_manager_instance is None:
        settings = get_settings()
        _auth_manager_instance = AuthManager(settings.db_dir, logger=logger)
    return _auth_manager_instance


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

    Set FASTAPI_ALLOW_ANONYMOUS_ACCESS=true to bypass authentication for development/testing.
    """
    import os

    # Check if anonymous access is allowed via environment variable
    allow_anonymous = os.environ.get("FASTAPI_ALLOW_ANONYMOUS_ACCESS", "").lower() in ["true", "1", "yes"]
    if allow_anonymous:
        return {
            "username": "anonymous",
            "email": "anonymous@localhost",
            "roles": ["admin", "reviewer", "annotator"]  # Use roles array like real users
        }

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


def require_admin_user(
    user: Dict = Depends(require_authenticated_user)
) -> Dict:
    """
    Require authenticated user with admin role.
    Use for admin-only endpoints.

    Args:
        user: Authenticated user from require_authenticated_user

    Returns:
        User dict if admin

    Raises:
        HTTPException: 403 if user doesn't have admin role
    """
    user_roles = user.get('roles', [])
    # Check for explicit 'admin' role or wildcard '*'
    if 'admin' not in user_roles and '*' not in user_roles:
        raise HTTPException(
            status_code=403,
            detail="Admin access required"
        )
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


# SSE and Sync dependencies (Phase 6)

def get_sse_service() -> SSEService:
    """Get singleton SSEService instance"""
    global _sse_service_instance
    if _sse_service_instance is None:
        _sse_service_instance = SSEService(logger=logger)
    return _sse_service_instance


def get_sync_service(
    file_repo: FileRepository = Depends(get_file_repository),
    file_storage: FileStorage = Depends(get_file_storage),
    sse_service: SSEService = Depends(get_sse_service)
) -> Optional[SyncService]:
    """Get SyncService instance with dependencies. Returns None if WebDAV is not configured."""
    settings = get_settings()

    # Check if WebDAV is configured
    if not settings.webdav_base_url:
        return None

    # Build WebDAV config
    webdav_config = {
        'base_url': settings.webdav_base_url,
        'username': settings.webdav_username,
        'password': settings.webdav_password,
        'remote_root': settings.webdav_remote_root
    }

    return SyncService(
        file_repo=file_repo,
        file_storage=file_storage,
        webdav_config=webdav_config,
        sse_service=sse_service,
        logger=logger
    )


# Alias for backward compatibility with Phase 3-5 naming
generate_session_id = require_session_id
get_session_user = require_authenticated_user
