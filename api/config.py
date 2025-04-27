from flask import Blueprint, jsonify, request, current_app
import os
from lib.decorators import handle_api_errors
from lib.server_utils import ApiError
import json

bp = Blueprint("config", __name__, url_prefix="/api/config")
prompt_path = os.path.join(os.path.dirname(__file__), "..", "data", "prompt.json")

@bp.route("/instructions", methods=["GET"])
@handle_api_errors
def get_instructions():
    if os.path.exists(prompt_path):
        with open(prompt_path, 'r', encoding='utf-8') as f:
            instructions = json.load(f)
    else:   
        instructions = []
    return jsonify(instructions)

@bp.route("/instructions", methods=["POST"])
@handle_api_errors
def save_instructions():
    data = request.get_json()
    with open(prompt_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=4)
    current_app.logger.info(f"Saved instructions.")
    return jsonify({"result": "ok"})