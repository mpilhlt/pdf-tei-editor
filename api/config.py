# Very simple json file based config management, configuration changes will lead to repo changes
# Todo: user-specific config values

from flask import Blueprint, jsonify, request, current_app
import os
import threading
import json

from api.lib.decorators import handle_api_errors
from api.lib.server_utils import ApiError

bp = Blueprint("config", __name__, url_prefix="/api/config")

# Paths
DATA_PATH = os.path.join("data")
INSTRUCTION_DATA_PATH = os.path.join(DATA_PATH, "prompt.json")
CONFIG_FILE_PATH = os.path.join(DATA_PATH,'config.json')

# Concurrency lock
config_lock = threading.Lock()

def read_config():
    """Reads the config file, handling file not found and JSON errors."""
    with config_lock:
        try:
            with open(CONFIG_FILE_PATH, 'r', encoding='utf-8') as f:
                return json.load(f)
        except IOError as e:
            print(f"Error reading config file {CONFIG_FILE_PATH}: {e}")
            # Re-raise the exception or return an error indicator
            raise e

def write_config(config_data):
    """Writes the config data to the file safely."""
    with config_lock:
        try:
            with open(CONFIG_FILE_PATH, 'w', encoding='utf-8') as f:
                json.dump(config_data, f, indent=2)
        except IOError as e:
            print(f"Error writing config file {CONFIG_FILE_PATH}: {e}")
            # Re-raise the exception
            raise e
        
@bp.route("/get/<key>", methods=["GET"])
@handle_api_errors 
def get_config_value(key):
    """Retrieves a configuration value by key."""
    if not isinstance(key, str) or not key:
        raise ValueError("Invalid or empty key")

    config_data = read_config()
    if key in config_data:
        # Wrap the value in an object for consistency, especially if value is simple
        return jsonify(config_data[key]), 200
    else:
        raise ValueError(f"Key '{key}' not found")


@bp.route("/set", methods=["POST"])
# @handle_api_errors # Uncomment if you use a decorator
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
def get_instructions():
    if os.path.exists(INSTRUCTION_DATA_PATH):
        with open(INSTRUCTION_DATA_PATH, 'r', encoding='utf-8') as f:
            instructions = json.load(f)
    else:   
        instructions = [{"label":"Default instructions", "text":[]}]
    return jsonify(instructions)

@bp.route("/instructions", methods=["POST"])
@handle_api_errors
def save_instructions():
    data = request.get_json()
    with open(INSTRUCTION_DATA_PATH, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=4)
    current_app.logger.info(f"Saved instructions.")
    return jsonify({"result": "ok"})