from flask import Blueprint, jsonify, request, current_app
import os
import logging
from pathlib import Path

from server.lib.decorators import handle_api_errors, session_required
from server.lib.server_utils import (
    ApiError, safe_file_path, get_session_id, resolve_document_identifier
)
from server.lib.cache_manager import mark_cache_dirty, mark_sync_needed
from server.lib.auth import get_user_by_session_id
from server.lib.access_control import check_file_access

logger = logging.getLogger(__name__)
bp = Blueprint("files_delete", __name__, url_prefix="/api/files")

@bp.route("/delete", methods=["POST"])
@handle_api_errors      
@session_required
def delete():
    """
    Delete the given files
    """
    data_root = current_app.config["DATA_ROOT"]
    files = request.get_json()
    if not files or not isinstance(files, list): 
        raise ApiError("Files must be a list of paths")
    
    session_id = get_session_id(request)
    user = get_user_by_session_id(session_id)
    
    for file in files: 
        # Resolve hash to path if needed, then get real file path
        resolved_path = resolve_document_identifier(file)
        
        # Check write access permissions for deletion
        if not check_file_access(resolved_path, user, 'write'):
            raise ApiError(f"Insufficient permissions to delete {resolved_path}", status_code=403)
        
        file_path = os.path.join(data_root, safe_file_path(resolved_path))
        # delete the file 
        logger.info(f"Deleting file {file_path}")
        if os.path.exists(file_path):
            # delete file
            os.remove(file_path)
            
            if current_app.config['WEBDAV_ENABLED']: 
                # add a delete marker 
                Path(file_path + ".deleted").touch()
        else:
            raise ApiError(f"File {file_path} does not exist")
    
    # Mark cache as dirty since we deleted files
    mark_cache_dirty()
    # Mark sync as needed since files were changed
    mark_sync_needed()
    return jsonify({"result": "ok"})