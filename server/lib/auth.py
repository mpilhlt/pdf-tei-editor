import json
import threading
from flask import current_app
from server.lib import sessions

USERS_FILE = None
auth_lock = threading.Lock()

def _get_users_file():
    """Initializes and returns the path to users.json."""
    global USERS_FILE
    if USERS_FILE is None:
        USERS_FILE = current_app.config["DB_DIR"] / 'users.json'
    return USERS_FILE

def _read_users():
    """Reads the users.json file."""
    with auth_lock:
        try:
            with open(_get_users_file(), 'r', encoding='utf-8') as f:
                return json.load(f)
        except (IOError, json.JSONDecodeError) as e:
            current_app.logger.error(f"Error reading users file: {e}")
            return []

def _write_users(users_data):
    """Writes data to the users.json file."""
    with auth_lock:
        try:
            with open(_get_users_file(), 'w', encoding='utf-8') as f:
                json.dump(users_data, f, indent=2)
        except IOError as e:
            current_app.logger.error(f"Error writing users file: {e}")

def get_user_by_session_id(session_id):
    """Finds a user by their session ID."""
    if not session_id:
        return None
    
    # Get session timeout from config  
    try:
        import json
        config_file = current_app.config["DB_DIR"] / 'config.json'
        with open(config_file, 'r', encoding='utf-8') as f:
            config = json.load(f)
        timeout_seconds = config.get('session.timeout', 86400)
    except:
        timeout_seconds = 86400  # fallback
    
    # Check if session is valid
    if not sessions.is_session_valid(session_id, timeout_seconds):
        return None
    
    # Get username from session
    username = sessions.get_username_by_session_id(session_id)
    if not username:
        return None
    
    # Get user data
    user = get_user_by_username(username)
    if user:
        # Remove session_id field if it exists (legacy data)
        user_copy = user.copy()
        user_copy.pop('session_id', None)
        return user_copy
    
    return None

def get_user_by_username(username):
    """Finds a user by their username."""
    users = _read_users()
    for user in users:
        if user.get('username') == username:
            return user
    return None

def create_user_session(username, session_id):
    """Creates a new session for a user."""
    user = get_user_by_username(username)
    if user:
        sessions.create_session(session_id, username)
        return True
    return False

def update_session_access_time(session_id):
    """Updates the last access time for a session."""
    return sessions.update_session_access_time(session_id)

def delete_user_session(session_id):
    """Deletes a specific session."""
    return sessions.delete_session(session_id)

def cleanup_expired_sessions():
    """Cleans up expired sessions."""
    try:
        import json
        config_file = current_app.config["DB_DIR"] / 'config.json'
        with open(config_file, 'r', encoding='utf-8') as f:
            config = json.load(f)
        timeout_seconds = config.get('session.timeout', 86400)
    except:
        timeout_seconds = 86400
    
    return sessions.cleanup_expired_sessions(timeout_seconds)

def verify_password(username, passwd_hash):
    """Verifies the user's password hash."""
    user = get_user_by_username(username)
    if user and user.get('passwd_hash') == passwd_hash:
        return True
    return False
