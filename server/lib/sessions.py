import json
import threading
import time
from flask import current_app
from pathlib import Path

SESSIONS_FILE = None
sessions_lock = threading.Lock()

def _get_sessions_file():
    """Initializes and returns the path to sessions.json."""
    global SESSIONS_FILE
    if SESSIONS_FILE is None:
        SESSIONS_FILE = current_app.config["DB_DIR"] / 'sessions.json'
    return SESSIONS_FILE

def _read_sessions():
    """Reads the sessions.json file."""
    with sessions_lock:
        try:
            with open(_get_sessions_file(), 'r', encoding='utf-8') as f:
                return json.load(f)
        except (IOError, json.JSONDecodeError) as e:
            if isinstance(e, FileNotFoundError):
                # Create empty sessions file if it doesn't exist
                # Don't call _write_sessions to avoid deadlock, write directly
                sessions_file = _get_sessions_file()
                sessions_file.parent.mkdir(parents=True, exist_ok=True)
                with open(sessions_file, 'w', encoding='utf-8') as f:
                    json.dump({}, f, indent=2)
                return {}
            current_app.logger.error(f"Error reading sessions file: {e}")
            return {}

def _write_sessions(sessions_data):
    """Writes data to the sessions.json file."""
    with sessions_lock:
        try:
            sessions_file = _get_sessions_file()
            sessions_file.parent.mkdir(parents=True, exist_ok=True)
            with open(sessions_file, 'w', encoding='utf-8') as f:
                json.dump(sessions_data, f, indent=2)
        except IOError as e:
            current_app.logger.error(f"Error writing sessions file: {e}")

def create_session(session_id, username):
    """Creates a new session for a user."""
    sessions = _read_sessions()
    sessions[session_id] = {
        'username': username,
        'created_at': time.time(),
        'last_access': time.time()
    }
    _write_sessions(sessions)
    current_app.logger.info(f"Created session {session_id} for user {username}")

def get_session(session_id):
    """Retrieves a session by ID."""
    if not session_id:
        return None
    sessions = _read_sessions()
    return sessions.get(session_id)

def get_username_by_session_id(session_id):
    """Gets the username associated with a session ID."""
    session = get_session(session_id)
    return session['username'] if session else None

def update_session_access_time(session_id):
    """Updates the last access time for a session."""
    if not session_id:
        return False
    
    sessions = _read_sessions()
    if session_id in sessions:
        sessions[session_id]['last_access'] = time.time()
        _write_sessions(sessions)
        return True
    return False

def delete_session(session_id):
    """Deletes a session."""
    if not session_id:
        return False
    
    sessions = _read_sessions()
    if session_id in sessions:
        username = sessions[session_id]['username']
        del sessions[session_id]
        _write_sessions(sessions)
        current_app.logger.info(f"Deleted session {session_id} for user {username}")
        return True
    return False

def delete_all_user_sessions(username):
    """Deletes all sessions for a specific user."""
    sessions = _read_sessions()
    sessions_to_delete = [sid for sid, session in sessions.items() 
                         if session['username'] == username]
    
    for session_id in sessions_to_delete:
        del sessions[session_id]
    
    if sessions_to_delete:
        _write_sessions(sessions)
        current_app.logger.info(f"Deleted {len(sessions_to_delete)} sessions for user {username}")
    
    return len(sessions_to_delete)

def cleanup_expired_sessions(timeout_seconds):
    """Removes sessions that haven't been accessed within the timeout period."""
    sessions = _read_sessions()
    current_time = time.time()
    expired_sessions = []
    
    for session_id, session in sessions.items():
        last_access = session.get('last_access', session.get('created_at', 0))
        if current_time - last_access > timeout_seconds:
            expired_sessions.append(session_id)
    
    for session_id in expired_sessions:
        username = sessions[session_id]['username']
        del sessions[session_id]
        current_app.logger.info(f"Cleaned up expired session {session_id} for user {username}")
    
    if expired_sessions:
        _write_sessions(sessions)
    
    return len(expired_sessions)

def get_user_session_count(username):
    """Returns the number of active sessions for a user."""
    sessions = _read_sessions()
    return sum(1 for session in sessions.values() if session['username'] == username)

def is_session_valid(session_id, timeout_seconds):
    """Checks if a session exists and hasn't expired."""
    session = get_session(session_id)
    if not session:
        return False
    
    current_time = time.time()
    last_access = session.get('last_access', session.get('created_at', 0))
    return current_time - last_access <= timeout_seconds