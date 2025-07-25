import json
import threading
from flask import current_app

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
    users = _read_users()
    for user in users:
        if user.get('session_id') == session_id:
            return user
    return None

def get_user_by_username(username):
    """Finds a user by their username."""
    users = _read_users()
    for user in users:
        if user.get('username') == username:
            return user
    return None

def update_user_session(username, session_id):
    """Updates the session ID for a user."""
    users = _read_users()
    for user in users:
        if user.get('username') == username:
            user['session_id'] = session_id
            _write_users(users)
            return True
    return False

def verify_password(username, passwd_hash):
    """Verifies the user's password hash."""
    user = get_user_by_username(username)
    if user and user.get('passwd_hash') == passwd_hash:
        return True
    return False
