from flask import Blueprint, jsonify, request
import logging

from server.lib.decorators import handle_api_errors, session_required
from server.lib.server_utils import ApiError, get_session_id, resolve_document_identifier
from server.lib.locking import acquire_lock, release_lock, get_all_active_locks, check_lock
from server.lib.auth import get_user_by_session_id
from server.lib.access_control import check_file_access

logger = logging.getLogger(__name__)
bp = Blueprint("files_locks", __name__, url_prefix="/api/files")

@bp.route("/locks", methods=["GET"])
@handle_api_errors
@session_required
def get_all_locks_route():  
    """Fetches all active locks."""
    active_locks = get_all_active_locks()
    return jsonify(active_locks)

@bp.route("/check_lock", methods=["POST"])
@handle_api_errors
@session_required
def check_lock_route():
    """Checks if a single file is locked."""
    data = request.get_json()
    file_path_or_hash = data.get("file_path")
    if not file_path_or_hash:
        raise ApiError("File path is required.")
    file_path = resolve_document_identifier(file_path_or_hash)
    session_id = get_session_id(request)
    return jsonify(check_lock(file_path, session_id))

@bp.route("/acquire_lock", methods=["POST"])
@handle_api_errors
@session_required
def acquire_lock_route():
    """Acquire a lock for this file."""
    data = request.get_json()
    file_path_or_hash = data.get("file_path")
    if not file_path_or_hash:
        raise ApiError("File path is required.")
    file_path = resolve_document_identifier(file_path_or_hash)
    session_id = get_session_id(request)
    
    # Check access control - user must have edit permissions to acquire lock
    user = get_user_by_session_id(session_id)
    if not check_file_access(file_path, user, 'edit'):
        raise ApiError("Access denied: You don't have permission to edit this document", status_code=403)
    
    if acquire_lock(file_path, session_id):
        return jsonify("OK")
    # could not acquire lock
    raise ApiError(f'Could not acquire lock for {file_path}', 423)

@bp.route("/release_lock", methods=["POST"])
@handle_api_errors
@session_required
def release_lock_route():
    """Releases the lock for a given file path."""
    data = request.get_json()
    file_path_or_hash = data.get("file_path")
    if not file_path_or_hash:
        raise ApiError("File path is required.")
    file_path = resolve_document_identifier(file_path_or_hash)
    session_id = get_session_id(request)
    if release_lock(file_path, session_id):
        return jsonify({"status": "lock_released"})
    else:
        raise ApiError("Failed to release lock. It may have been acquired by another session.", status_code=409)