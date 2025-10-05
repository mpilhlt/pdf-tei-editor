import json
import threading
from pathlib import Path
from typing import Optional, Dict, Any
import logging

from .sessions import SessionManager
from .config_utils import get_config_value

logger = logging.getLogger(__name__)

class AuthManager:
    def __init__(self, db_dir: Path):
        self.db_dir = Path(db_dir)
        self.users_file = self.db_dir / 'users.json'
        self.auth_lock = threading.Lock()
        self.session_manager = SessionManager(db_dir)

    def _read_users(self) -> list:
        """Reads the users.json file."""
        with self.auth_lock:
            try:
                with open(self.users_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except (IOError, json.JSONDecodeError) as e:
                logger.error(f"Error reading users file: {e}")
                return []

    def _write_users(self, users_data: list):
        """Writes data to the users.json file."""
        with self.auth_lock:
            try:
                self.users_file.parent.mkdir(parents=True, exist_ok=True)
                with open(self.users_file, 'w', encoding='utf-8') as f:
                    json.dump(users_data, f, indent=2)
            except IOError as e:
                logger.error(f"Error writing users file: {e}")

    def get_user_by_session_id(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Finds a user by their session ID."""
        if not session_id:
            return None

        # Get session timeout from config
        try:
            timeout_seconds = get_config_value('session.timeout', self.db_dir, logger) or 86400
        except:
            timeout_seconds = 86400  # fallback

        # Check if session is valid
        if not self.session_manager.is_session_valid(session_id, timeout_seconds):
            return None

        # Get username from session
        username = self.session_manager.get_username_by_session_id(session_id)
        if not username:
            return None

        # Get user data
        user = self.get_user_by_username(username)
        if user:
            # Remove session_id field if it exists (legacy data) and passwd_hash
            user_copy = user.copy()
            user_copy.pop('session_id', None)
            user_copy.pop('passwd_hash', None)
            return user_copy

        return None

    def get_user_by_username(self, username: str) -> Optional[Dict[str, Any]]:
        """Finds a user by their username."""
        users = self._read_users()
        for user in users:
            if user.get('username') == username:
                return user
        return None

    def create_user_session(self, username: str, session_id: str) -> bool:
        """Creates a new session for a user."""
        user = self.get_user_by_username(username)
        if user:
            self.session_manager.create_session(session_id, username)
            return True
        return False

    def update_session_access_time(self, session_id: str) -> bool:
        """Updates the last access time for a session."""
        return self.session_manager.update_session_access_time(session_id)

    def delete_user_session(self, session_id: str) -> bool:
        """Deletes a specific session."""
        return self.session_manager.delete_session(session_id)

    def cleanup_expired_sessions(self) -> int:
        """Cleans up expired sessions."""
        try:
            timeout_seconds = get_config_value('session.timeout', self.db_dir, logger) or 86400
        except:
            timeout_seconds = 86400

        return self.session_manager.cleanup_expired_sessions(timeout_seconds)

    def verify_password(self, username: str, passwd_hash: str) -> bool:
        """Verifies the user's password hash."""
        user = self.get_user_by_username(username)
        if user and user.get('passwd_hash') == passwd_hash:
            return True
        return False