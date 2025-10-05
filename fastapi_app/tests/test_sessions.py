"""
Unit tests for sessions.py (SQLite-based)

Self-contained tests that can be run independently.
"""

import tempfile
import time
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from fastapi_app.lib.sessions import SessionManager


class TestSessionManager(unittest.TestCase):
    """Test SQLite-based session manager."""

    def setUp(self):
        """Create temporary directory and session manager for each test."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_dir = Path(self.temp_dir.name)
        self.session_mgr = SessionManager(self.db_dir)

    def tearDown(self):
        """Clean up temporary directory."""
        self.temp_dir.cleanup()

    def test_database_initialization(self):
        """Test that database and table are created."""
        self.assertTrue((self.db_dir / 'sessions.db').exists())

    def test_create_session(self):
        """Test creating a session."""
        session_id = self.session_mgr.create_session('testuser')

        self.assertIsNotNone(session_id)
        self.assertTrue(len(session_id) > 0)
        # UUID4 format check
        self.assertEqual(len(session_id), 36)  # UUID4 with hyphens

    def test_get_session(self):
        """Test getting a session."""
        session_id = self.session_mgr.create_session('testuser')
        session = self.session_mgr.get_session(session_id)

        self.assertIsNotNone(session)
        self.assertEqual(session['username'], 'testuser')
        self.assertEqual(session['session_id'], session_id)
        self.assertIn('created_at', session)
        self.assertIn('last_access', session)

    def test_get_nonexistent_session(self):
        """Test getting a session that doesn't exist."""
        session = self.session_mgr.get_session('nonexistent-id')
        self.assertIsNone(session)

    def test_get_session_with_none(self):
        """Test getting session with None ID."""
        session = self.session_mgr.get_session(None)
        self.assertIsNone(session)

    def test_get_username_by_session_id(self):
        """Test getting username from session ID."""
        session_id = self.session_mgr.create_session('testuser')
        username = self.session_mgr.get_username_by_session_id(session_id)

        self.assertEqual(username, 'testuser')

    def test_get_username_nonexistent_session(self):
        """Test getting username from nonexistent session."""
        username = self.session_mgr.get_username_by_session_id('nonexistent')
        self.assertIsNone(username)

    def test_is_session_valid(self):
        """Test session validation."""
        session_id = self.session_mgr.create_session('testuser')

        # Should be valid with long timeout
        self.assertTrue(self.session_mgr.is_session_valid(session_id, timeout_seconds=86400))

        # Should be invalid with very short timeout after waiting
        time.sleep(0.2)
        self.assertFalse(self.session_mgr.is_session_valid(session_id, timeout_seconds=0.1))

    def test_is_session_valid_nonexistent(self):
        """Test validation of nonexistent session."""
        self.assertFalse(self.session_mgr.is_session_valid('nonexistent', timeout_seconds=86400))

    def test_update_session_access_time(self):
        """Test updating session access time."""
        session_id = self.session_mgr.create_session('testuser')

        session_before = self.session_mgr.get_session(session_id)
        time.sleep(0.1)

        updated = self.session_mgr.update_session_access_time(session_id)
        self.assertTrue(updated)

        session_after = self.session_mgr.get_session(session_id)
        self.assertGreater(session_after['last_access'], session_before['last_access'])

    def test_update_nonexistent_session(self):
        """Test updating nonexistent session."""
        updated = self.session_mgr.update_session_access_time('nonexistent')
        self.assertFalse(updated)

    def test_update_session_with_none(self):
        """Test updating session with None ID."""
        updated = self.session_mgr.update_session_access_time(None)
        self.assertFalse(updated)

    def test_delete_session(self):
        """Test deleting a session."""
        session_id = self.session_mgr.create_session('testuser')

        deleted = self.session_mgr.delete_session(session_id)
        self.assertTrue(deleted)

        session = self.session_mgr.get_session(session_id)
        self.assertIsNone(session)

    def test_delete_nonexistent_session(self):
        """Test deleting nonexistent session."""
        deleted = self.session_mgr.delete_session('nonexistent')
        self.assertFalse(deleted)

    def test_delete_session_with_none(self):
        """Test deleting session with None ID."""
        deleted = self.session_mgr.delete_session(None)
        self.assertFalse(deleted)

    def test_get_user_session_count(self):
        """Test counting user sessions."""
        # No sessions initially
        count = self.session_mgr.get_user_session_count('testuser')
        self.assertEqual(count, 0)

        # Create multiple sessions
        self.session_mgr.create_session('testuser')
        self.session_mgr.create_session('testuser')
        self.session_mgr.create_session('otheruser')

        count = self.session_mgr.get_user_session_count('testuser')
        self.assertEqual(count, 2)

        count = self.session_mgr.get_user_session_count('otheruser')
        self.assertEqual(count, 1)

    def test_delete_all_user_sessions(self):
        """Test deleting all sessions for a user."""
        # Create multiple sessions
        self.session_mgr.create_session('testuser')
        self.session_mgr.create_session('testuser')
        self.session_mgr.create_session('testuser')
        self.session_mgr.create_session('otheruser')

        # Delete all testuser sessions
        deleted_count = self.session_mgr.delete_all_user_sessions('testuser')
        self.assertEqual(deleted_count, 3)

        # Verify testuser has no sessions
        count = self.session_mgr.get_user_session_count('testuser')
        self.assertEqual(count, 0)

        # Verify otheruser still has sessions
        count = self.session_mgr.get_user_session_count('otheruser')
        self.assertEqual(count, 1)

    def test_delete_all_sessions_nonexistent_user(self):
        """Test deleting sessions for nonexistent user."""
        deleted_count = self.session_mgr.delete_all_user_sessions('nonexistent')
        self.assertEqual(deleted_count, 0)

    def test_cleanup_expired_sessions(self):
        """Test cleaning up expired sessions."""
        # Create sessions
        session_id1 = self.session_mgr.create_session('user1')
        session_id2 = self.session_mgr.create_session('user2')
        session_id3 = self.session_mgr.create_session('user3')

        # Wait a bit
        time.sleep(0.2)

        # Update access time for session3 (keep it alive)
        self.session_mgr.update_session_access_time(session_id3)

        # Cleanup with short timeout (should remove session1 and session2)
        cleaned_count = self.session_mgr.cleanup_expired_sessions(timeout_seconds=0.1)
        self.assertEqual(cleaned_count, 2)

        # Verify session3 still exists
        session = self.session_mgr.get_session(session_id3)
        self.assertIsNotNone(session)

        # Verify session1 and session2 are gone
        self.assertIsNone(self.session_mgr.get_session(session_id1))
        self.assertIsNone(self.session_mgr.get_session(session_id2))

    def test_cleanup_expired_sessions_none_expired(self):
        """Test cleanup when no sessions are expired."""
        self.session_mgr.create_session('user1')
        self.session_mgr.create_session('user2')

        # Long timeout - nothing should be cleaned
        cleaned_count = self.session_mgr.cleanup_expired_sessions(timeout_seconds=86400)
        self.assertEqual(cleaned_count, 0)

    def test_get_all_sessions(self):
        """Test getting all sessions."""
        # Create sessions
        session_id1 = self.session_mgr.create_session('user1')
        session_id2 = self.session_mgr.create_session('user2')

        all_sessions = self.session_mgr.get_all_sessions()

        self.assertEqual(len(all_sessions), 2)

        # Check that both sessions are present
        session_ids = {s['session_id'] for s in all_sessions}
        self.assertIn(session_id1, session_ids)
        self.assertIn(session_id2, session_ids)

        # Check ordering (by last_access DESC)
        # session2 was created later, so should be first
        self.assertEqual(all_sessions[0]['session_id'], session_id2)

    def test_get_all_sessions_empty(self):
        """Test getting all sessions when none exist."""
        all_sessions = self.session_mgr.get_all_sessions()
        self.assertEqual(all_sessions, [])

    def test_multiple_sessions_same_user(self):
        """Test creating multiple sessions for the same user."""
        session_id1 = self.session_mgr.create_session('testuser')
        session_id2 = self.session_mgr.create_session('testuser')
        session_id3 = self.session_mgr.create_session('testuser')

        # All should be unique
        self.assertNotEqual(session_id1, session_id2)
        self.assertNotEqual(session_id2, session_id3)
        self.assertNotEqual(session_id1, session_id3)

        # All should be retrievable
        self.assertIsNotNone(self.session_mgr.get_session(session_id1))
        self.assertIsNotNone(self.session_mgr.get_session(session_id2))
        self.assertIsNotNone(self.session_mgr.get_session(session_id3))

        # Count should be 3
        count = self.session_mgr.get_user_session_count('testuser')
        self.assertEqual(count, 3)

    def test_session_timestamps(self):
        """Test that session timestamps are set correctly."""
        session_id = self.session_mgr.create_session('testuser')
        session = self.session_mgr.get_session(session_id)

        # created_at and last_access should be approximately equal at creation
        self.assertAlmostEqual(session['created_at'], session['last_access'], delta=0.1)

        # Both should be recent (within last second)
        current_time = time.time()
        self.assertLess(current_time - session['created_at'], 1.0)

    def test_concurrent_session_operations(self):
        """Test concurrent session operations."""
        import threading

        results = []

        def create_and_check(username):
            session_id = self.session_mgr.create_session(username)
            session = self.session_mgr.get_session(session_id)
            results.append((username, session is not None))

        # Start multiple threads
        threads = []
        for i in range(10):
            t = threading.Thread(target=create_and_check, args=(f'user{i}',))
            threads.append(t)
            t.start()

        # Wait for all threads
        for t in threads:
            t.join()

        # All operations should succeed
        self.assertEqual(len(results), 10)
        for username, success in results:
            self.assertTrue(success, f"Session creation failed for {username}")

        # Verify all sessions exist
        all_sessions = self.session_mgr.get_all_sessions()
        self.assertEqual(len(all_sessions), 10)


if __name__ == '__main__':
    unittest.main()
