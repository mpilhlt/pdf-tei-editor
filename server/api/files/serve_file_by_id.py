from flask import Blueprint, jsonify, request, current_app, send_file
import os
import logging

from server.lib.decorators import handle_api_errors
from server.lib.server_utils import (
    ApiError, safe_file_path, get_session_id, resolve_document_identifier
)
from server.lib.auth import get_user_by_session_id
from server.lib.access_control import check_file_access

logger = logging.getLogger(__name__)
bp = Blueprint("files_serve_file_by_id", __name__, url_prefix="/api/files")

@bp.route("/<document_id>", methods=["GET"])
@handle_api_errors
def serve_file_by_id(document_id):
    """
    Serve file content by document identifier (hash or path).
    This allows URLs like /files/abc123 to serve the actual file content.
    """
    try:
        if document_id == "empty.pdf":
            # special case
            absolute_path = '/app/web/empty.pdf'
            
        else: 
            # Resolve the document identifier to a full path
            file_path = resolve_document_identifier(document_id)
            if file_path is None: 
                raise ApiError(f"File not found for identifier: {document_id}", status_code=404)
            
            # Check read access permissions
            session_id = get_session_id(request)
            user = get_user_by_session_id(session_id) if session_id else None
            
            if not check_file_access(file_path, user, 'read'):
                raise ApiError("Access denied: You don't have permission to view this document", status_code=403)
            
            # Convert to absolute system path
            data_root = current_app.config["DATA_ROOT"]
            safe_path = safe_file_path(file_path)
            absolute_path = os.path.join(data_root, safe_path)
            
            # Check if file exists
            if not os.path.exists(absolute_path):
                raise ApiError(f"File not found for identifier: {document_id}", status_code=404)
        
        # Serve the file
        return send_file(absolute_path)
        
    except ApiError:
        # Re-raise API errors as-is
        raise
    except Exception as e:
        logger.error(f"Error serving file {document_id}: {e}")
        raise ApiError("Failed to serve file", status_code=500)