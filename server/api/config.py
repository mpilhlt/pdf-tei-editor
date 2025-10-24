# Very simple json file based config management, configuration changes will lead to repo changes
# Todo: user-specific config values, protect route with authentication

from flask import Blueprint, jsonify, request, current_app
import os
import threading
import json
import logging

from ..lib.decorators import handle_api_errors, session_required
from ..lib.server_utils import has_internet

logger = logging.getLogger(__name__)

bp = Blueprint("config", __name__, url_prefix="/api/config")

# Paths
CONFIG_PATH = os.path.join("db")
INSTRUCTION_DATA_PATH = os.path.join(CONFIG_PATH, "prompt.json")
CONFIG_FILE_PATH = os.path.join(CONFIG_PATH,'config.json')

# Concurrency lock
config_lock = threading.Lock()

def read_config() -> dict:
    """Reads the config file, handling file not found and JSON errors."""
    with config_lock:
        try:
            with open(CONFIG_FILE_PATH, 'r', encoding='utf-8') as f:
                config = json.load(f) # type: dict

            for key in config.keys():
                # Check for environment variable override
                env_key = f"PDF_TEI_EDITOR_CONFIG_{key.replace('.', '_')}"
                env_value = os.environ.get(env_key)

                if env_value is not None:
                    try:
                        # Parse the environment variable value as JSON
                        config[key] = json.loads(env_value)
                        
                    except json.JSONDecodeError as e:
                        logger.warning(f"Invalid JSON in environment variable {env_key}: {e}")
                        # Fall through to config file if env var is invalid

            return config

        except IOError as e:
            print(f"Error reading config file {CONFIG_FILE_PATH}: {e}")
            # Re-raise the exception or return an error indicator
            raise e

def write_config(config_data:dict):
    """Writes the config data to the file safely."""
    with config_lock:
        try:
            with open(CONFIG_FILE_PATH, 'w', encoding='utf-8') as f:
                json.dump(config_data, f, indent=2)
        except IOError as e:
            print(f"Error writing config file {CONFIG_FILE_PATH}: {e}")
            # Re-raise the exception
            raise e


@bp.route("/list", methods=["GET"])
@handle_api_errors
#@session_required # TODO disabled because of /app/src/app.js#L160 
def api_config_route():
    config_data = read_config()
    return jsonify(config_data), 200


@bp.route("/get/<key>", methods=["GET"])
@handle_api_errors
#@session_required # disabled because of /app/src/app.js#L160
def get_config_value(key):
    """Retrieves a configuration value by key.

    Environment variable override: If PDF_TEI_EDITOR_CONFIG_<KEY> exists,
    it overrides the value from config.json. The key is transformed by
    replacing dots with underscores (e.g., 'sse.enabled' -> 'sse_enabled').
    The environment variable value is parsed as JSON.
    """
    if not isinstance(key, str) or not key:
        raise ValueError("Invalid or empty key")

    config_data = read_config()
    if key in config_data:
        # Wrap the value in an object for consistency, especially if value is simple
        return jsonify(config_data[key]), 200
    else:
        raise ValueError(f"Key '{key}' not found")


@bp.route("/set", methods=["POST"])
@handle_api_errors
@session_required
def set_config_value():
    """Sets a configuration value for a given key."""
    data = request.get_json()
    key = data.get('key', None)
    value = data.get('value', None)

    if key is None or not isinstance(key, str):
         raise ValueError("Missing 'key' in request body")
    if 'value' not in data:
         raise ValueError("Missing 'value' in request body")

    config_data = read_config()
    config_data[key] = value
    write_config(config_data)
    return jsonify({"result": "OK"}), 200
        

@bp.route("/instructions", methods=["GET"])
@handle_api_errors
@session_required
def get_instructions():
    if os.path.exists(INSTRUCTION_DATA_PATH):
        with open(INSTRUCTION_DATA_PATH, 'r', encoding='utf-8') as f:
            instructions = json.load(f)
    else:   
        instructions = [{"label":"Default instructions", "extractor": ["llamore-gemini"], "text":[]}]
    return jsonify(instructions)

@bp.route("/instructions", methods=["POST"])
@handle_api_errors
@session_required
def save_instructions():
    data = request.get_json()
    with open(INSTRUCTION_DATA_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=4)
    logger.info(f"Saved instructions.")
    return jsonify({"result": "ok"})

@bp.route("/state", methods=["GET"])
@handle_api_errors
def state():
    return {
        "webdavEnabled": os.environ.get('WEBDAV_ENABLED') == "1",
        "hasInternet": has_internet()
    }