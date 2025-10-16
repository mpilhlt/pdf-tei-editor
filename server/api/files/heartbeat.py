from flask import Blueprint, jsonify, request
import logging

from server.lib.decorators import handle_api_errors, session_required
from server.lib.server_utils import ApiError, get_session_id, resolve_document_identifier
from server.lib.locking import acquire_lock
from server.lib.cache_manager import get_cache_status

logger = logging.getLogger(__name__)
bp = Blueprint("files_heartbeat", __name__, url_prefix="/api/files")

@bp.route("/heartbeat", methods=["POST"])
@handle_api_errors
@session_required
def heartbeat():
    """
    Refreshes the lock for a given file path.
    This acts as a heartbeat to prevent a lock from becoming stale.
    Also returns the current cache status to enable efficient file data refresh.
    """
    data = request.get_json()
    # Support both 'file_path' (legacy) and 'file_id' (FastAPI v1) for forward compatibility
    file_path_or_hash = data.get("file_path") or data.get("file_id")
    if not file_path_or_hash:
        raise ApiError("File path or file_id is required for heartbeat.")
    file_path = resolve_document_identifier(file_path_or_hash)
    session_id = get_session_id(request)
    # The existing acquire_lock function already handles refreshing
    # a lock if it's owned by the same session.
    if acquire_lock(file_path, session_id):
        # Include cache status in heartbeat response
        cache_status = get_cache_status()
        return jsonify({
            "status": "lock_refreshed",
            "cache_status": cache_status
        })
    else:
        # This would happen if the lock was lost or taken by another user.
        raise ApiError("Failed to refresh lock. It may have been acquired by another session.", status_code=409)