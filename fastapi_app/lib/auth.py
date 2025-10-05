"""
Authentication management for PDF-TEI-Editor.

This module provides framework-agnostic authentication utilities with dependency injection.
No Flask or FastAPI dependencies - all parameters are explicitly passed.
"""

import json
import sys
import threading
from pathlib import Path
from typing import Optional


# Platform-specific imports for file locking
if sys.platform == 'win32':
    import msvcrt
else:
    import fcntl


def _lock_file(file_handle):
    """Cross-platform file locking"""
    if sys.platform == 'win32':
        try:
            msvcrt.locking(file_handle.fileno(), msvcrt.LK_LOCK, 1)
        except OSError:
            pass
    else:
        fcntl.flock(file_handle, fcntl.LOCK_EX)


def _unlock_file(file_handle):
    """Cross-platform file unlocking"""
    if sys.platform == 'win32':
        try:
            msvcrt.locking(file_handle.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
    else:
        fcntl.flock(file_handle, fcntl.LOCK_UN)


class AuthManager:
    """
    Authentication manager with dependency injection.

    Manages user authentication and password verification.
    Uses SHA-256 password hashing for compatibility with existing system.
    """

    def __init__(self, db_dir: Path, logger=None):
        """
        Initialize authentication manager.

        Args:
            db_dir: Path to the database directory containing users.json
            logger: Optional logger instance for logging operations
        """
        self.db_dir = db_dir
        self.logger = logger
        self.users_file = db_dir / 'users.json'
        self.lock = threading.Lock()

    def _read_users(self) -> list:
        """
        Read users from users.json file.

        Returns:
            List of user dictionaries
        """
        with self.lock:
            try:
                if not self.users_file.exists():
                    # Create empty users file
                    self.users_file.parent.mkdir(parents=True, exist_ok=True)
                    with open(self.users_file, 'w', encoding='utf-8') as f:
                        json.dump([], f, indent=2)
                    return []

                with open(self.users_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except (IOError, json.JSONDecodeError) as e:
                if self.logger:
                    self.logger.error(f"Error reading users file: {e}")
                return []

    def _write_users(self, users_data: list):
        """
        Write users to users.json file.

        Args:
            users_data: List of user dictionaries to write
        """
        with self.lock:
            try:
                self.users_file.parent.mkdir(parents=True, exist_ok=True)
                with open(self.users_file, 'w', encoding='utf-8') as f:
                    json.dump(users_data, f, indent=2)
            except IOError as e:
                if self.logger:
                    self.logger.error(f"Error writing users file: {e}")

    def get_user_by_username(self, username: str) -> Optional[dict]:
        """
        Get user by username.

        Args:
            username: Username to look up

        Returns:
            User dictionary or None if not found
        """
        users = self._read_users()
        for user in users:
            if user.get('username') == username:
                # Return copy without sensitive session data
                user_copy = user.copy()
                user_copy.pop('session_id', None)  # Remove legacy session_id
                return user_copy
        return None

    def verify_password(self, username: str, passwd_hash: str) -> Optional[dict]:
        """
        Verify password hash and return user if valid.

        Uses SHA-256 password hashing for compatibility.

        Args:
            username: Username to verify
            passwd_hash: SHA-256 hash of the password

        Returns:
            User dictionary if credentials valid, None otherwise
        """
        user = self.get_user_by_username(username)
        if user and user.get('passwd_hash') == passwd_hash:
            if self.logger:
                self.logger.info(f"Password verified for user {username}")
            return user

        if self.logger:
            self.logger.warning(f"Failed password verification for user {username}")
        return None

    def get_user_by_session_id(self, session_id: str, session_manager=None) -> Optional[dict]:
        """
        Get user by session ID.

        This is a convenience method that delegates to the session manager.
        Requires a SessionManager instance to be passed in.

        Args:
            session_id: Session ID to look up
            session_manager: SessionManager instance for session validation

        Returns:
            User dictionary or None if session invalid
        """
        if not session_id or not session_manager:
            return None

        # Get username from session
        username = session_manager.get_username_by_session_id(session_id)
        if not username:
            return None

        # Get user data
        return self.get_user_by_username(username)

    def create_user(self, username: str, passwd_hash: str, **kwargs) -> bool:
        """
        Create a new user.

        Args:
            username: Username for the new user
            passwd_hash: SHA-256 hash of the password
            **kwargs: Additional user attributes (e.g., email, role)

        Returns:
            True if user created, False if user already exists
        """
        users = self._read_users()

        # Check if user already exists
        if any(user.get('username') == username for user in users):
            if self.logger:
                self.logger.warning(f"User {username} already exists")
            return False

        # Create new user
        new_user = {
            'username': username,
            'passwd_hash': passwd_hash,
            **kwargs
        }
        users.append(new_user)
        self._write_users(users)

        if self.logger:
            self.logger.info(f"Created user {username}")
        return True

    def update_user(self, username: str, **kwargs) -> bool:
        """
        Update user attributes.

        Args:
            username: Username of the user to update
            **kwargs: Attributes to update

        Returns:
            True if user updated, False if user not found
        """
        users = self._read_users()

        for user in users:
            if user.get('username') == username:
                user.update(kwargs)
                self._write_users(users)
                if self.logger:
                    self.logger.info(f"Updated user {username}")
                return True

        if self.logger:
            self.logger.warning(f"User {username} not found for update")
        return False

    def delete_user(self, username: str) -> bool:
        """
        Delete a user.

        Args:
            username: Username of the user to delete

        Returns:
            True if user deleted, False if user not found
        """
        users = self._read_users()
        original_length = len(users)

        users = [user for user in users if user.get('username') != username]

        if len(users) < original_length:
            self._write_users(users)
            if self.logger:
                self.logger.info(f"Deleted user {username}")
            return True

        if self.logger:
            self.logger.warning(f"User {username} not found for deletion")
        return False
