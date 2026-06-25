"""
Configuration API endpoints for FastAPI.

Provides configuration management, instructions, and state information.
"""

from typing import Any, Optional, List
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException, Depends
import json

from ..lib.core.dependencies import require_authenticated_user
from ..lib.utils.config_utils import get_config, get_config_metadata, MASKED_SENTINEL
from ..lib.utils.logging_utils import get_logger


logger = get_logger(__name__)
router = APIRouter(prefix="/config", tags=["configuration"])

config = get_config()


# Pydantic Models

class ConfigSetRequest(BaseModel):
    """Request model for setting config values"""
    key: str
    value: Any
    value_type: Optional[str] = None
    allowed_values: Optional[list[Any]] = None
    description: Optional[str] = None
    masked: Optional[bool] = None


class InstructionItem(BaseModel):
    """Model for extraction instructions"""
    label: str
    extractor: List[str]
    text: List[str]


_SENSITIVE_KEY_PATTERNS = ('api.key', 'api-key', 'password')


def _get_public_config(cfg: dict[str, Any]) -> dict[str, Any]:
    """Return config dict with masked/sensitive keys removed."""
    return {
        k: v for k, v in cfg.items()
        if not cfg.get(f"{k}.masked")                           # metadata-driven
        and not any(p in k for p in _SENSITIVE_KEY_PATTERNS)   # pattern-based safety net
    }


class StateResponse(BaseModel):
    """Response model for application state"""
    hasInternet: Optional[bool] = None
    publicConfig: Optional[dict[str, Any]] = None


class ConfigSetResponse(BaseModel):
    """Response for config set operation"""
    result: str


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
async def list_config(
    project: Optional[str] = None,
    user: dict = Depends(require_authenticated_user)
) -> dict:
    """
    List all configuration values, optionally merged with project-specific overrides.

    If project is provided, project-level config keys override global defaults.
    Requires authentication.
    """
    config_data = config.load(apply_masks=True)
    if project:
        try:
            from ..lib.utils.project_utils import project_config_get_all
            from ..config import get_settings
            overrides = project_config_get_all(get_settings().db_dir, project)
            if overrides:
                for k, v in overrides.items():
                    if config_data.get(f"{k}.masked") is True:
                        overrides[k] = MASKED_SENTINEL
                config_data = {**config_data, **overrides}
        except Exception:
            logger.warning("project_config_get_all failed; ignoring project param")
    return config_data


@router.get("/get/{key}")
async def get_config_value_endpoint(
    key: str,
    user: dict = Depends(require_authenticated_user)
) -> Any:
    """
    Get a specific configuration value by key.

    Returns the value associated with the key.
    Requires authentication.
    """
    if not key:
        raise HTTPException(status_code=400, detail="Invalid or empty key")

    config_data = config.load()

    if key not in config_data:
        raise HTTPException(status_code=404, detail=f"Key '{key}' not found")

    if config_data.get(f"{key}.masked") is True:
        return MASKED_SENTINEL

    return config_data[key]


class ConfigMetadataResponse(BaseModel):
    """Metadata for a config key."""
    key: str
    type: Optional[str] = None
    values: Optional[list[Any]] = None
    description: Optional[str] = None
    masked: bool = False


@router.get("/metadata/{key}", response_model=ConfigMetadataResponse)
async def get_config_metadata_endpoint(
    key: str,
    user: dict = Depends(require_authenticated_user)
) -> ConfigMetadataResponse:
    """Get metadata (type, allowed values, description) for a config key. Requires authentication."""
    from ..config import get_settings
    settings = get_settings()
    meta = get_config_metadata(key, settings.db_dir)
    return ConfigMetadataResponse(key=key, **meta)


@router.post("/set", response_model=ConfigSetResponse)
async def set_config(
    request_data: ConfigSetRequest,
    user: dict = Depends(require_authenticated_user)
):
    """
    Set a configuration value.

    Requires authentication.
    """
    if not request_data.key:
        raise HTTPException(status_code=400, detail="Missing 'key' in request")

    if request_data.value == MASKED_SENTINEL:
        raise HTTPException(status_code=400, detail="Cannot save masked sentinel value")

    success, message = config.set(
        request_data.key,
        request_data.value,
        value_type=request_data.value_type,
        allowed_values=request_data.allowed_values,
        description=request_data.description,
        masked=request_data.masked,
    )

    if not success:
        raise HTTPException(status_code=400, detail=message)

    logger.info(f"User {user['username']} set config {request_data.key}")

    return ConfigSetResponse(result="OK")


@router.get("/instructions", response_model=List[InstructionItem])
async def get_instructions(user: dict = Depends(require_authenticated_user)) -> List[InstructionItem]:
    """
    Get extraction instructions.

    Requires authentication.
    Returns list of instruction items.
    """
    from ..config import get_settings
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
    user: dict = Depends(require_authenticated_user)
) -> SaveInstructionsResponse:
    """
    Save extraction instructions.

    Requires authentication.
    """
    from ..config import get_settings
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

    Returns internet connectivity and all non-sensitive config values (publicConfig).
    This is the only config endpoint that does not require authentication.
    Sensitive config keys (API keys, passwords) are excluded from publicConfig.
    """
    return StateResponse(
        hasInternet=has_internet(),
        publicConfig=_get_public_config(config.load()),
    )
