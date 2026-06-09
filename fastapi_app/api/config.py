"""
Configuration API endpoints for FastAPI.

Provides configuration management, instructions, and state information.
"""

from typing import Any, Optional, List
from pydantic import BaseModel
from fastapi import APIRouter, Request, HTTPException, Depends
from pathlib import Path
import json
import os

from ..config import get_settings
from ..lib.utils.auth import AuthManager
from ..lib.core.sessions import SessionManager
from ..lib.utils.server_utils import get_session_id_from_request
from ..lib.utils.config_utils import get_config, get_config_metadata
from ..lib.utils.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/config", tags=["configuration"])

# Get config instance
config = get_config()


# Pydantic Models

class ConfigSetRequest(BaseModel):
    """Request model for setting config values"""
    key: str
    value: Any
    value_type: Optional[str] = None
    allowed_values: Optional[list[Any]] = None
    description: Optional[str] = None


class InstructionItem(BaseModel):
    """Model for extraction instructions"""
    label: str
    extractor: List[str]
    text: List[str]


class StateResponse(BaseModel):
    """Response model for application state"""
    hasInternet: Optional[bool] = None


class ConfigSetResponse(BaseModel):
    """Response for config set operation"""
    result: str


# Authentication dependency

async def require_auth(request: Request) -> dict:
    """
    Dependency that requires valid authentication.

    Returns authenticated user data.
    """
    settings = get_settings()
    session_id = get_session_id_from_request(request)

    if not session_id:
        raise HTTPException(status_code=401, detail="Authentication required")

    auth_manager = AuthManager(settings.db_dir, logger=logger)
    session_manager = SessionManager(settings.db_dir, logger=logger)

    # Validate session
    if not session_manager.is_session_valid(session_id, settings.session_timeout):
        raise HTTPException(status_code=401, detail="Session expired")

    # Get user
    user = auth_manager.get_user_by_session_id(session_id, session_manager)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid session")

    return user


# Helper functions

def has_internet() -> bool:
    """Check if internet connection is available"""
    # Simple check - can be enhanced later
    import socket
    try:
        socket.create_connection(("8.8.8.8", 53), timeout=3)
        return True
    except OSError:
        return False


# API Endpoints

@router.get("/list", response_model=dict)
async def list_config(project: Optional[str] = None) -> dict:
    """
    List all configuration values, optionally merged with project-specific overrides.

    If project is provided, project-level config keys override global defaults.
    """
    config_data = config.load()
    if project:
        try:
            from ..lib.utils.project_utils import project_config_get_all
            overrides = project_config_get_all(get_settings().db_dir, project)
            if overrides:
                config_data = {**config_data, **overrides}
        except Exception:
            logger.warning("project_config_get_all failed; ignoring project param")
    return config_data


@router.get("/get/{key}")
async def get_config(key: str) -> Any:
    """
    Get a specific configuration value by key.

    Returns the value associated with the key.
    """
    if not key:
        raise HTTPException(status_code=400, detail="Invalid or empty key")

    config_data = config.load()

    if key not in config_data:
        raise HTTPException(status_code=404, detail=f"Key '{key}' not found")

    return config_data[key]


class ConfigMetadataResponse(BaseModel):
    """Metadata for a config key."""
    key: str
    type: Optional[str] = None
    values: Optional[list[Any]] = None
    description: Optional[str] = None


@router.get("/metadata/{key}", response_model=ConfigMetadataResponse)
async def get_config_metadata_endpoint(key: str) -> ConfigMetadataResponse:
    """Get metadata (type, allowed values, description) for a config key."""
    settings = get_settings()
    meta = get_config_metadata(key, settings.db_dir)
    return ConfigMetadataResponse(key=key, **meta)


@router.post("/set", response_model=ConfigSetResponse)
async def set_config(
    request_data: ConfigSetRequest,
    user: dict = Depends(require_auth)
):
    """
    Set a configuration value.

    Requires authentication.
    """
    if not request_data.key:
        raise HTTPException(status_code=400, detail="Missing 'key' in request")

    success, message = config.set(
        request_data.key,
        request_data.value,
        value_type=request_data.value_type,
        allowed_values=request_data.allowed_values,
        description=request_data.description
    )

    if not success:
        raise HTTPException(status_code=400, detail=message)

    logger.info(f"User {user['username']} set config {request_data.key}")

    return ConfigSetResponse(result="OK")


@router.get("/instructions", response_model=List[InstructionItem])
async def get_instructions(user: dict = Depends(require_auth)) -> List[InstructionItem]:
    """
    Get extraction instructions.

    Requires authentication.
    Returns list of instruction items.
    """
    settings = get_settings()
    instruction_file = settings.db_dir / "prompt.json"

    if instruction_file.exists():
        with open(instruction_file, 'r', encoding='utf-8') as f:
            instructions = json.load(f)
    else:
        instructions = [{
            "label": "Default instructions",
            "extractor": ["llamore-gemini"],
            "text": []
        }]

    return instructions


class SaveInstructionsResponse(BaseModel):
    """Response for saving instructions"""
    result: str


@router.post("/instructions", response_model=SaveInstructionsResponse)
async def save_instructions(
    instructions: List[InstructionItem],
    user: dict = Depends(require_auth)
) -> SaveInstructionsResponse:
    """
    Save extraction instructions.

    Requires authentication.
    """
    settings = get_settings()
    instruction_file = settings.db_dir / "prompt.json"

    # Ensure directory exists
    instruction_file.parent.mkdir(parents=True, exist_ok=True)

    # Convert Pydantic models to dicts for JSON serialization
    instructions_data = [item.model_dump() for item in instructions]

    with open(instruction_file, 'w', encoding='utf-8') as f:
        json.dump(instructions_data, f, indent=4)

    logger.info(f"User {user['username']} saved instructions")

    return SaveInstructionsResponse(result="ok")


@router.get("/state", response_model=StateResponse)
async def get_state():
    """
    Get application state information.

    Returns state including internet connectivity.
    """
    return StateResponse(hasInternet=has_internet())
