from flask import Blueprint, jsonify
import logging

from server.lib.decorators import handle_api_errors
from server.lib.cache_manager import get_cache_status

logger = logging.getLogger(__name__)
bp = Blueprint("files_cache_status", __name__, url_prefix="/api/files")

@bp.route("/cache_status", methods=["GET"])
@handle_api_errors
def cache_status():
    """Get the current file data cache status."""
    return jsonify(get_cache_status())