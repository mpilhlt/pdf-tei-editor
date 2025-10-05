from fastapi import APIRouter, HTTPException, Request, Depends
from http import HTTPStatus
from pydantic import BaseModel
from typing import Any, Dict, List, Optional
import os
import threading
import json
import logging
from pathlib import Path

from ..config import settings
from ..lib.auth import AuthManager
from ..lib.server_utils import get_session_id_from_request

logger = logging.getLogger(__name__)

# Pydantic models
class ConfigSetRequest(BaseModel):
    key: str
    value: Any

class ConfigSetResponse(BaseModel):
    result: str = "OK"

class StateResponse(BaseModel):
    webdavEnabled: bool

class InstructionItem(BaseModel):
    label: str
    extractor: List[str]
    text: List[str]

class ErrorResponse(BaseModel):
    error: str

# Create router
router = APIRouter(prefix="/api/config", tags=["config"])

# Global config lock
config_lock = threading.Lock()

def get_config_file_path() -> Path:
    """Returns the path to the config.json file."""
    return Path(settings.DB_DIR) / 'config.json'

def get_instruction_file_path() -> Path:
    """Returns the path to the prompt.json file."""
    return Path(settings.DB_DIR) / 'prompt.json'

def read_config() -> dict:
    """Reads the config file, handling file not found and JSON errors."""
    with config_lock:
        try:
            config_path = get_config_file_path()
            with open(config_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except IOError as e:
            logger.error(f"Error reading config file {config_path}: {e}")
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                detail=f"Error reading config file: {e}"
            )

def write_config(config_data: dict):
    """Writes the config data to the file safely."""
    with config_lock:
        try:
            config_path = get_config_file_path()
            config_path.parent.mkdir(parents=True, exist_ok=True)
            with open(config_path, 'w', encoding='utf-8') as f:
                json.dump(config_data, f, indent=2)
        except IOError as e:
            logger.error(f"Error writing config file {config_path}: {e}")
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                detail=f"Error writing config file: {e}"
            )

# Dependency for auth manager
def get_auth_manager() -> AuthManager:
    return AuthManager(settings.DB_DIR)

# Dependency for session authentication
async def require_session(request: Request, auth_manager: AuthManager = Depends(get_auth_manager)):
    """Dependency that requires a valid session."""
    session_id = get_session_id_from_request(request)
    user = auth_manager.get_user_by_session_id(session_id)
    if not user:
        raise HTTPException(
            status_code=HTTPStatus.UNAUTHORIZED,
            detail="Not authenticated."
        )
    return user

@router.get("/list")
async def list_config():
    """Lists all configuration values."""
    config_data = read_config()
    return config_data

@router.get("/get/{key}")
async def get_config_value(key: str):
    """Retrieves a configuration value by key."""
    if not key:
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail="Invalid or empty key"
        )

    config_data = read_config()
    if key in config_data:
        return config_data[key]
    else:
        raise HTTPException(
            status_code=HTTPStatus.NOT_FOUND,
            detail=f"Key '{key}' not found"
        )

@router.post("/set", response_model=ConfigSetResponse)
async def set_config_value(
    request: ConfigSetRequest,
    user=Depends(require_session)
):
    """Sets a configuration value for a given key."""
    if not request.key:
        raise HTTPException(
            status_code=HTTPStatus.BAD_REQUEST,
            detail="Missing 'key' in request body"
        )

    config_data = read_config()
    config_data[request.key] = request.value
    write_config(config_data)
    return ConfigSetResponse()

@router.get("/instructions")
async def get_instructions(user=Depends(require_session)) -> List[InstructionItem]:
    """Gets AI extraction instructions."""
    instruction_path = get_instruction_file_path()
    if instruction_path.exists():
        try:
            with open(instruction_path, 'r', encoding='utf-8') as f:
                instructions = json.load(f)
        except (IOError, json.JSONDecodeError) as e:
            logger.error(f"Error reading instructions file: {e}")
            raise HTTPException(
                status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
                detail=f"Error reading instructions file: {e}"
            )
    else:
        instructions = [{"label": "Default instructions", "extractor": ["llamore-gemini"], "text": []}]

    return [InstructionItem(**item) for item in instructions]

@router.post("/instructions")
async def save_instructions(
    instructions: List[InstructionItem],
    user=Depends(require_session)
):
    """Saves AI extraction instructions."""
    try:
        instruction_path = get_instruction_file_path()
        instruction_path.parent.mkdir(parents=True, exist_ok=True)
        with open(instruction_path, 'w', encoding='utf-8') as f:
            json.dump([item.model_dump() for item in instructions], f, indent=4)
        logger.info(f"Saved instructions.")
        return {"result": "ok"}
    except IOError as e:
        logger.error(f"Error writing instructions file: {e}")
        raise HTTPException(
            status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
            detail=f"Error writing instructions file: {e}"
        )

@router.get("/state", response_model=StateResponse)
async def get_state():
    """Gets application state information."""
    return StateResponse(
        webdavEnabled=os.environ.get('WEBDAV_ENABLED') == "1"
    )