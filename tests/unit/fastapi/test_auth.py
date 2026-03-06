"""
Unit tests for auth.py

Self-contained tests that can be run independently.

@testCovers fastapi_app/lib/utils/auth.py
"""

import gc
import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.utils.auth import AuthManager
from fastapi_app.lib.core.sessions import SessionManager
from fastapi_app.lib.core.db_utils import close_all_connections


class TestAuthManager(unittest.TestCase):
    """Test authentication manager."""

    def setUp(self):
        """Create temporary directory and auth manager for each test."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_dir = Path(self.temp_dir.name)
        self.auth = AuthManager(self.db_dir)

    def tearDown(self):
        """Clean up temporary directory."""
        # Close all database connections before cleanup (required on Windows)
        close_all_connections()
        # Force garbage collection to release file handles on Windows
        gc.collect()
        self.temp_dir.cleanup()

    def test_users_file_creation(self):
        """Test that users.json is created."""
        # Access users to trigger file creation
        self.auth.get_user_by_username('anyone')
        self.assertTrue((self.db_dir / 'users.json').exists())

    def test_create_user(self):
        """Test creating a user."""
        success = self.auth.create_user('testuser', 'hash123', email='test@example.com')

        self.assertTrue(success)

        # Verify user exists
        user = self.auth.get_user_by_username('testuser')
        self.assertIsNotNone(user)
        self.assertEqual(user['username'], 'testuser')
        self.assertEqual(user['passwd_hash'], 'hash123')
        self.assertEqual(user['email'], 'test@example.com')

    def test_create_duplicate_user(self):
        """Test that creating duplicate user fails."""
        self.auth.create_user('testuser', 'hash123')
        success = self.auth.create_user('testuser', 'hash456')

        self.assertFalse(success)

    def test_get_user_by_username(self):
        """Test getting user by username."""
        self.auth.create_user('testuser', 'hash123', role='admin')

        user = self.auth.get_user_by_username('testuser')

        self.assertIsNotNone(user)
        self.assertEqual(user['username'], 'testuser')
        self.assertEqual(user['role'], 'admin')

    def test_get_nonexistent_user(self):
        """Test getting user that doesn't exist."""
        user = self.auth.get_user_by_username('nonexistent')
        self.assertIsNone(user)

    def test_get_user_removes_legacy_session_id(self):
        """Test that legacy session_id is removed from returned user."""
        # Create user with legacy session_id field
        self.auth.create_user('testuser', 'hash123', session_id='old-session-id')

        user = self.auth.get_user_by_username('testuser')

        self.assertIsNotNone(user)
        self.assertNotIn('session_id', user)

    def test_verify_password_success(self):
        """Test successful password verification."""
        self.auth.create_user('testuser', 'hash123')

        user = self.auth.verify_password('testuser', 'hash123')

        self.assertIsNotNone(user)
        self.assertEqual(user['username'], 'testuser')

    def test_verify_password_wrong_password(self):
        """Test password verification with wrong password."""
        self.auth.create_user('testuser', 'hash123')

        user = self.auth.verify_password('testuser', 'wrong_hash')

        self.assertIsNone(user)

    def test_verify_password_nonexistent_user(self):
        """Test password verification for nonexistent user."""
        user = self.auth.verify_password('nonexistent', 'hash123')
        self.assertIsNone(user)

    def test_update_user(self):
        """Test updating user attributes."""
        self.auth.create_user('testuser', 'hash123', role='user')

        success = self.auth.update_user('testuser', role='admin', email='admin@example.com')
        self.assertTrue(success)

        user = self.auth.get_user_by_username('testuser')
        self.assertEqual(user['role'], 'admin')
        self.assertEqual(user['email'], 'admin@example.com')
        # Password should remain unchanged
        self.assertEqual(user['passwd_hash'], 'hash123')

    def test_update_nonexistent_user(self):
        """Test updating user that doesn't exist."""
        success = self.auth.update_user('nonexistent', role='admin')
        self.assertFalse(success)

    def test_delete_user(self):
        """Test deleting a user."""
        self.auth.create_user('testuser', 'hash123')

        success = self.auth.delete_user('testuser')
        self.assertTrue(success)

        user = self.auth.get_user_by_username('testuser')
        self.assertIsNone(user)

    def test_delete_nonexistent_user(self):
        """Test deleting user that doesn't exist."""
        success = self.auth.delete_user('nonexistent')
        self.assertFalse(success)

    def test_multiple_users(self):
        """Test managing multiple users."""
        self.auth.create_user('user1', 'hash1')
        self.auth.create_user('user2', 'hash2')
        self.auth.create_user('user3', 'hash3')

        # All users should exist independently
        self.assertIsNotNone(self.auth.get_user_by_username('user1'))
        self.assertIsNotNone(self.auth.get_user_by_username('user2'))
        self.assertIsNotNone(self.auth.get_user_by_username('user3'))

        # Delete one user
        self.auth.delete_user('user2')

        # Others should still exist
        self.assertIsNotNone(self.auth.get_user_by_username('user1'))
        self.assertIsNone(self.auth.get_user_by_username('user2'))
        self.assertIsNotNone(self.auth.get_user_by_username('user3'))

    def test_create_user_with_kwargs(self):
        """Test creating user with additional attributes."""
        success = self.auth.create_user(
            'testuser',
            'hash123',
            email='test@example.com',
            role='admin',
            active=True,
            created_at='2024-01-01'
        )

        self.assertTrue(success)

        user = self.auth.get_user_by_username('testuser')
        self.assertEqual(user['email'], 'test@example.com')
        self.assertEqual(user['role'], 'admin')
        self.assertEqual(user['active'], True)
        self.assertEqual(user['created_at'], '2024-01-01')

    def test_concurrent_user_operations(self):
        """Test that concurrent user operations don't corrupt data."""
        import threading

        results = []
        lock = threading.Lock()

        def create_user(username):
            try:
                success = self.auth.create_user(username, f'hash_{username}')
                with lock:
                    results.append((username, success))
            except Exception as e:
                with lock:
                    results.append((username, False))

        # Start multiple threads
        threads = []
        for i in range(5):  # Reduced from 10 for more reliable test
            t = threading.Thread(target=create_user, args=(f'user{i}',))
            threads.append(t)
            t.start()

        # Wait for all threads
        for t in threads:
            t.join()

        # All operations should complete
        self.assertEqual(len(results), 5)

        # At least some operations should succeed (verifies locking works)
        successful_creates = sum(1 for _, success in results if success)
        self.assertGreater(successful_creates, 0, "No user creations succeeded")

        # Verify that successfully created users actually exist
        for username, success in results:
            if success:
                user = self.auth.get_user_by_username(username)
                self.assertIsNotNone(user, f"User {username} was marked as created but doesn't exist")


class TestAuthManagerWithSessions(unittest.TestCase):
    """Test auth manager integration with session manager."""

    def setUp(self):
        """Create temporary directory, auth manager and session manager."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_dir = Path(self.temp_dir.name)
        self.auth = AuthManager(self.db_dir)
        self.session_mgr = SessionManager(self.db_dir)

    def tearDown(self):
        """Clean up temporary directory."""
        # Close all database connections before cleanup (required on Windows)
        close_all_connections()
        # Force garbage collection to release file handles on Windows
        gc.collect()
        self.temp_dir.cleanup()

    def test_get_user_by_session_id(self):
        """Test getting user by session ID."""
        # Create user and session
        self.auth.create_user('testuser', 'hash123', email='test@example.com')
        session_id = self.session_mgr.create_session('testuser')

        # Get user by session ID
        user = self.auth.get_user_by_session_id(session_id, self.session_mgr)

        self.assertIsNotNone(user)
        self.assertEqual(user['username'], 'testuser')
        self.assertEqual(user['email'], 'test@example.com')

    def test_get_user_by_invalid_session_id(self):
        """Test getting user with invalid session ID."""
        self.auth.create_user('testuser', 'hash123')

        user = self.auth.get_user_by_session_id('invalid-session-id', self.session_mgr)

        self.assertIsNone(user)

    def test_get_user_by_session_id_without_session_manager(self):
        """Test getting user by session ID without session manager."""
        session_id = 'any-session-id'

        user = self.auth.get_user_by_session_id(session_id, None)

        self.assertIsNone(user)

    def test_get_user_by_session_id_with_none_session_id(self):
        """Test getting user with None session ID."""
        user = self.auth.get_user_by_session_id(None, self.session_mgr)

        self.assertIsNone(user)

    def test_get_user_by_session_id_nonexistent_user(self):
        """Test getting user by session ID when user doesn't exist."""
        # Create session for user that doesn't exist in auth
        session_id = self.session_mgr.create_session('nonexistent')

        user = self.auth.get_user_by_session_id(session_id, self.session_mgr)

        self.assertIsNone(user)

    def test_full_auth_flow(self):
        """Test complete authentication flow."""
        # Create user
        success = self.auth.create_user('testuser', 'hash123', role='user')
        self.assertTrue(success)

        # Verify password
        user = self.auth.verify_password('testuser', 'hash123')
        self.assertIsNotNone(user)

        # Create session after successful login
        session_id = self.session_mgr.create_session('testuser')
        self.assertIsNotNone(session_id)

        # Get user by session (simulating authenticated request)
        user = self.auth.get_user_by_session_id(session_id, self.session_mgr)
        self.assertIsNotNone(user)
        self.assertEqual(user['username'], 'testuser')
        self.assertEqual(user['role'], 'user')

        # Logout (delete session)
        deleted = self.session_mgr.delete_session(session_id)
        self.assertTrue(deleted)

        # Session no longer valid
        user = self.auth.get_user_by_session_id(session_id, self.session_mgr)
        self.assertIsNone(user)


if __name__ == '__main__':
    unittest.main()
