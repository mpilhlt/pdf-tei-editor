import json
import threading
import time
from pathlib import Path
from typing import Optional, Dict, Any
import logging

logger = logging.getLogger(__name__)

class SessionManager:
    def __init__(self, db_dir: Path):
        self.db_dir = Path(db_dir)
        self.sessions_file = self.db_dir / 'sessions.json'
        self.sessions_lock = threading.Lock()

    def _read_sessions(self) -> Dict[str, Any]:
        """Reads the sessions.json file."""
        with self.sessions_lock:
            try:
                with open(self.sessions_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except (IOError, json.JSONDecodeError) as e:
                if isinstance(e, FileNotFoundError):
                    # Create empty sessions file if it doesn't exist
                    self.sessions_file.parent.mkdir(parents=True, exist_ok=True)
                    with open(self.sessions_file, 'w', encoding='utf-8') as f:
                        json.dump({}, f, indent=2)
                    return {}
                logger.error(f"Error reading sessions file: {e}")
                return {}

    def _write_sessions(self, sessions_data: Dict[str, Any]):
        """Writes data to the sessions.json file."""
        with self.sessions_lock:
            try:
                self.sessions_file.parent.mkdir(parents=True, exist_ok=True)
                with open(self.sessions_file, 'w', encoding='utf-8') as f:
                    json.dump(sessions_data, f, indent=2)
            except IOError as e:
                logger.error(f"Error writing sessions file: {e}")

    def create_session(self, session_id: str, username: str):
        """Creates a new session for a user."""
        sessions = self._read_sessions()
        sessions[session_id] = {
            'username': username,
            'created_at': time.time(),
            'last_access': time.time()
        }
        self._write_sessions(sessions)
        logger.info(f"Created session {session_id} for user {username}")

    def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Retrieves a session by ID."""
        if not session_id:
            return None
        sessions = self._read_sessions()
        return sessions.get(session_id)

    def get_username_by_session_id(self, session_id: str) -> Optional[str]:
        """Gets the username associated with a session ID."""
        session = self.get_session(session_id)
        return session['username'] if session else None

    def update_session_access_time(self, session_id: str) -> bool:
        """Updates the last access time for a session."""
        if not session_id:
            return False

        sessions = self._read_sessions()
        if session_id in sessions:
            sessions[session_id]['last_access'] = time.time()
            self._write_sessions(sessions)
            return True
        return False

    def delete_session(self, session_id: str) -> bool:
        """Deletes a session."""
        if not session_id:
            return False

        sessions = self._read_sessions()
        if session_id in sessions:
            username = sessions[session_id]['username']
            del sessions[session_id]
            self._write_sessions(sessions)
            logger.info(f"Deleted session {session_id} for user {username}")
            return True
        return False

    def delete_all_user_sessions(self, username: str) -> int:
        """Deletes all sessions for a specific user."""
        sessions = self._read_sessions()
        sessions_to_delete = [sid for sid, session in sessions.items()
                             if session['username'] == username]

        for session_id in sessions_to_delete:
            del sessions[session_id]

        if sessions_to_delete:
            self._write_sessions(sessions)
            logger.info(f"Deleted {len(sessions_to_delete)} sessions for user {username}")

        return len(sessions_to_delete)

    def cleanup_expired_sessions(self, timeout_seconds: int) -> int:
        """Removes sessions that haven't been accessed within the timeout period."""
        sessions = self._read_sessions()
        current_time = time.time()
        expired_sessions = []

        for session_id, session in sessions.items():
            last_access = session.get('last_access', session.get('created_at', 0))
            if current_time - last_access > timeout_seconds:
                expired_sessions.append(session_id)

        for session_id in expired_sessions:
            username = sessions[session_id]['username']
            del sessions[session_id]
            logger.info(f"Cleaned up expired session {session_id} for user {username}")

        if expired_sessions:
            self._write_sessions(sessions)

        return len(expired_sessions)

    def get_user_session_count(self, username: str) -> int:
        """Returns the number of active sessions for a user."""
        sessions = self._read_sessions()
        return sum(1 for session in sessions.values() if session['username'] == username)

    def is_session_valid(self, session_id: str, timeout_seconds: int) -> bool:
        """Checks if a session exists and hasn't expired."""
        session = self.get_session(session_id)
        if not session:
            return False

        current_time = time.time()
        last_access = session.get('last_access', session.get('created_at', 0))
        return current_time - last_access <= timeout_seconds