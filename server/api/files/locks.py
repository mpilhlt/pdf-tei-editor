# locking API

from flask import Blueprint, jsonify, request
import logging

from server.lib.decorators import handle_api_errors, session_required
from server.lib.server_utils import ApiError, get_session_id, resolve_document_identifier
from server.lib.locking import acquire_lock, release_lock, check_lock, get_locked_file_ids
from server.lib.auth import get_user_by_session_id
from server.lib.access_control import check_file_access

logger = logging.getLogger(__name__)
bp = Blueprint("files_locks", __name__, url_prefix="/api/files")

@bp.route("/locks", methods=["GET"])
@handle_api_errors
@session_required
def get_all_locked_file_ids_route():
    """Fetches all active locks and returns a map of locked_file_path -> session_id"""
    active_locks = get_locked_file_ids()
    return jsonify(active_locks)

@bp.route("/check_lock", methods=["POST"])
@handle_api_errors
@session_required
def check_lock_route():
    """Checks if a single file is locked."""
    data = request.get_json()
    file_id = data.get("file_id")
    if not file_id:
        raise ApiError("File ID is required.")
    file_path = resolve_document_identifier(file_id)
    session_id = get_session_id(request)
    return jsonify(check_lock(file_path, session_id))

@bp.route("/acquire_lock", methods=["POST"])
@handle_api_errors
@session_required
def acquire_lock_route():
    """Acquire a lock for this file."""
    data = request.get_json()
    file_id = data.get("file_id")
    if not file_id:
        raise ApiError("File ID is required.")
    file_path = resolve_document_identifier(file_id)
    session_id = get_session_id(request)

    session_id_short = session_id[:8] if session_id else "unknown"
    logger.debug(f"[LOCK API] Session {session_id_short}... requesting lock for file_id={file_id}, path={file_path}")

    # Check access control - user must have edit permissions to acquire lock
    user = get_user_by_session_id(session_id)
    if not check_file_access(file_path, user, 'edit'):
        logger.warning(f"[LOCK API] Session {session_id_short}... DENIED due to insufficient permissions")
        raise ApiError("Access denied: You don't have permission to edit this document", status_code=403)

    if acquire_lock(file_path, session_id):
        logger.info(f"[LOCK API] Session {session_id_short}... successfully acquired lock for {file_path}")
        return jsonify("OK")
    # could not acquire lock
    logger.warning(f"[LOCK API] Session {session_id_short}... FAILED to acquire lock (423) for {file_path}")
    raise ApiError(f'Could not acquire lock for {file_path}', 423)

@bp.route("/release_lock", methods=["POST"])
@handle_api_errors
@session_required
def release_lock_route():
    """Releases the lock for a given file ID."""
    data = request.get_json()
    file_id = data.get("file_id")
    if not file_id:
        raise ApiError("File ID is required.")
    file_path = resolve_document_identifier(file_id)
    session_id = get_session_id(request)

    result = release_lock(file_path, session_id)

    if result["status"] == "success":
        # Return structured response
        return jsonify({
            "action": result["action"],
            "message": result["message"]
        })
    else:
        # This should not happen with current implementation, but handle gracefully
        raise ApiError(f"Failed to release lock: {result.get('message', 'Unknown error')}", status_code=409)