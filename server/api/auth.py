from flask import Blueprint, request, jsonify, current_app
from server.lib.decorators import handle_api_errors
from server.lib import auth
from server.lib.server_utils import get_session_id
from uuid import uuid4

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

@bp.route("/login", methods=["POST"])
@handle_api_errors
def login():
    """Logs a user in by verifying credentials and creating a new session."""
    data = request.get_json()
    username = data.get("username")
    passwd_hash = data.get("passwd_hash")

    if not all([username, passwd_hash]):
        return jsonify(error="Missing username or password hash."), 400

    if auth.verify_password(username, passwd_hash):
        # Clean up expired sessions before creating a new one
        auth.cleanup_expired_sessions()
        
        # Generate new session ID server-side
        session_id = str(uuid4())
        
        if auth.create_user_session(username, session_id):
            user_data = auth.get_user_by_session_id(session_id)
            if user_data:
                # remove password hash from response
                user_data.pop('passwd_hash', None)
                
                # Include session ID in response for client to store in state
                response_data = user_data.copy()
                response_data['sessionId'] = session_id
                return jsonify(response_data), 200
            else:
                return jsonify(error="Failed to retrieve user data."), 500
        else:
            return jsonify(error="Failed to create session."), 500
    else:
        return jsonify(error="Invalid credentials."), 401

@bp.route("/logout", methods=["POST"])
@handle_api_errors
def logout():
    """Logs a user out by deleting their session."""
    session_id = get_session_id(request)
    if session_id:
        # Close SSE connection if exists
        if hasattr(current_app, 'message_queues') and session_id in current_app.message_queues:
            # Send end signal to close SSE connection
            current_app.message_queues[session_id].put((None, None))
            current_app.logger.debug(f"Sent SSE close signal for session {session_id[:8]}...")

        auth.delete_user_session(session_id)
    return jsonify(status="logged_out"), 200

@bp.route("/status", methods=["GET"])
@handle_api_errors
def status():
    """Checks the current user's login status and refreshes session."""
    session_id = get_session_id(request)
    user = auth.get_user_by_session_id(session_id)
    if user:
        # Refresh session access time
        auth.update_session_access_time(session_id)
        user.pop('passwd_hash', None)
        return jsonify(user), 200
    else:
        return jsonify(error="Not authenticated."), 401
