from flask import Blueprint, request, jsonify, current_app
from server.lib.decorators import handle_api_errors
from server.lib import auth
from server.lib.server_utils import get_session_id

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

@bp.route("/login", methods=["POST"])
@handle_api_errors
def login():
    """Logs a user in by verifying credentials and updating the session."""
    data = request.get_json()
    username = data.get("username")
    passwd_hash = data.get("passwd_hash")
    session_id = get_session_id(request)

    if not all([username, passwd_hash, session_id]):
        return jsonify(error="Missing username, password hash, or session ID."), 400

    if auth.verify_password(username, passwd_hash):
        if auth.update_user_session(username, session_id):
            user_data = auth.get_user_by_session_id(session_id)
            # remove password hash from response
            del user_data['passwd_hash']
            return jsonify(user_data), 200
        else:
            return jsonify(error="Failed to update session."), 500
    else:
        return jsonify(error="Invalid credentials."), 401

@bp.route("/logout", methods=["POST"])
@handle_api_errors
def logout():
    """Logs a user out by clearing their session ID."""
    session_id = get_session_id(request)
    user = auth.get_user_by_session_id(session_id)
    if user:
        auth.update_user_session(user['username'], None)
    return jsonify(status="logged_out"), 200

@bp.route("/status", methods=["GET"])
@handle_api_errors
def status():
    """Checks the current user's login status."""
    session_id = get_session_id(request)
    user = auth.get_user_by_session_id(session_id)
    if user:
        del user['passwd_hash']
        return jsonify(user), 200
    else:
        return jsonify(error="Not authenticated."), 401
