from flask import Blueprint, jsonify, request, current_app
import logging

from server.lib.decorators import handle_api_errors
from server.lib.server_utils import get_session_id
from server.lib.file_data import get_file_data, apply_variant_filtering
from server.lib.cache_manager import is_cache_dirty
from server.lib.locking import get_all_active_locks
from server.lib.auth import get_user_by_session_id
from server.lib.access_control import DocumentAccessFilter

logger = logging.getLogger(__name__)
bp = Blueprint("files_list", __name__, url_prefix="/api/files")

@bp.route("/list", methods=["GET"])
@handle_api_errors
#@session_required
def file_list():
    # Get query parameters
    variant_filter = request.args.get('variant', None)
    force_refresh = request.args.get('refresh') == 'true'
    
    # Get file data with metadata already populated
    files_data = get_file_data(force_refresh=force_refresh or is_cache_dirty())
    
    # Add lock information if WebDAV is enabled
    webdav_enabled = current_app.config.get('WEBDAV_ENABLED', False)
    if webdav_enabled:
        active_locks = get_all_active_locks()
        session_id = get_session_id(request)
        
        for data in files_data:
            if "versions" in data:
                for version in data["versions"]:
                    version['is_locked'] = version['path'] in active_locks and active_locks.get(version['path']) != session_id
    
    # Apply variant filtering if specified
    if variant_filter is not None:
        files_data = apply_variant_filtering(files_data, variant_filter)
    
    # Apply access control filtering
    session_id = get_session_id(request)
    user = get_user_by_session_id(session_id) if session_id else None
    files_data = DocumentAccessFilter.filter_files_by_access(files_data, user)

    return jsonify(files_data)