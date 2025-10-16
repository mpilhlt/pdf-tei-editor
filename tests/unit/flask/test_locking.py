#!/usr/bin/env python3
"""
@testCovers server/lib/locking.py

Unit tests for SQLite-based file locking system.
Tests lock acquisition, release, staleness detection, and concurrent behavior.
"""

import unittest
import sys
import os
import tempfile
import time
from pathlib import Path
from datetime import datetime, timezone, timedelta

# Add server directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent / 'server'))

# Mock Flask app for testing
class MockConfig:
    def __init__(self, db_root):
        self.data = {"DB_ROOT": db_root}

    def get(self, key, default=None):
        return self.data.get(key, default)

class MockLogger:
    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        pass

    def error(self, msg):
        pass

    def exception(self, msg):
        pass

class MockApp:
    def __init__(self, db_root):
        self.config = MockConfig(db_root)
        self.logger = MockLogger()

# Import after setting up path
from lib import locking
from lib.server_utils import ApiError


class TestLockingSystem(unittest.TestCase):
    """Test cases for SQLite-based file locking."""

    def setUp(self):
        """Set up test environment with temporary database."""
        # Create temporary directory for test database
        self.temp_dir = tempfile.mkdtemp()

        # Mock the Flask current_app
        self.mock_app = MockApp(self.temp_dir)

        # Patch current_app in locking module
        locking.current_app = self.mock_app

        # Initialize test data
        self.test_file = "/data/test-document.xml"
        self.test_file2 = "/data/test-document2.xml"
        self.session1 = "session-abc-123"
        self.session2 = "session-xyz-789"

        # Initialize database
        locking.init_locks_db()

    def tearDown(self):
        """Clean up test environment."""
        # Remove temporary directory and all files
        import shutil
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir)

    def test_init_locks_db(self):
        """Test database initialization creates tables and indexes."""
        db_path = locking.get_db_path()
        self.assertTrue(os.path.exists(db_path), "Database file should be created")

        # Verify tables exist by querying
        with locking.get_db_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT name FROM sqlite_master
                WHERE type='table' AND name='locks'
            """)
            result = cursor.fetchone()
            self.assertIsNotNone(result, "locks table should exist")

    def test_acquire_new_lock(self):
        """Test acquiring a lock for the first time."""
        result = locking.acquire_lock(self.test_file, self.session1)
        self.assertTrue(result, "Should successfully acquire new lock")

        # Verify lock exists in database
        active_locks = locking.get_all_active_locks()
        self.assertIn(self.test_file, active_locks)
        self.assertEqual(active_locks[self.test_file], self.session1)

    def test_acquire_lock_refresh_same_session(self):
        """Test refreshing a lock from the same session."""
        # Acquire lock
        locking.acquire_lock(self.test_file, self.session1)

        # Try to acquire again from same session
        result = locking.acquire_lock(self.test_file, self.session1)
        self.assertTrue(result, "Should successfully refresh own lock")

        # Verify still locked by same session
        active_locks = locking.get_all_active_locks()
        self.assertEqual(active_locks[self.test_file], self.session1)

    def test_acquire_lock_blocked_by_other_session(self):
        """Test that lock acquisition fails when held by another session."""
        # Session 1 acquires lock
        locking.acquire_lock(self.test_file, self.session1)

        # Session 2 tries to acquire same lock
        result = locking.acquire_lock(self.test_file, self.session2)
        self.assertFalse(result, "Should fail to acquire lock held by another session")

        # Verify still locked by session 1
        active_locks = locking.get_all_active_locks()
        self.assertEqual(active_locks[self.test_file], self.session1)

    def test_acquire_stale_lock_takeover(self):
        """Test taking over a stale lock."""
        # Acquire lock
        locking.acquire_lock(self.test_file, self.session1)

        # Manually update the lock to make it stale
        with locking.get_db_connection() as conn:
            cursor = conn.cursor()
            stale_time = datetime.now(timezone.utc) - timedelta(seconds=locking.LOCK_TIMEOUT_SECONDS + 10)
            cursor.execute("""
                UPDATE locks
                SET updated_at = ?
                WHERE file_path = ?
            """, (stale_time.isoformat(), self.test_file))

        # Session 2 should be able to take over stale lock
        result = locking.acquire_lock(self.test_file, self.session2)
        self.assertTrue(result, "Should successfully take over stale lock")

        # Verify now locked by session 2
        active_locks = locking.get_all_active_locks()
        self.assertEqual(active_locks[self.test_file], self.session2)

    def test_release_lock_success(self):
        """Test releasing a lock successfully."""
        # Acquire lock
        locking.acquire_lock(self.test_file, self.session1)

        # Release lock
        result = locking.release_lock(self.test_file, self.session1)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["action"], "released")

        # Verify lock is gone
        active_locks = locking.get_all_active_locks()
        self.assertNotIn(self.test_file, active_locks)

    def test_release_lock_already_released(self):
        """Test releasing a lock that doesn't exist (idempotent)."""
        # Release non-existent lock
        result = locking.release_lock(self.test_file, self.session1)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["action"], "already_released")

    def test_release_lock_wrong_session(self):
        """Test that releasing another session's lock raises an error."""
        # Session 1 acquires lock
        locking.acquire_lock(self.test_file, self.session1)

        # Session 2 tries to release it
        with self.assertRaises(ApiError) as context:
            locking.release_lock(self.test_file, self.session2)

        self.assertEqual(context.exception.status_code, 409)

    def test_purge_stale_locks(self):
        """Test purging stale locks."""
        # Create multiple locks
        locking.acquire_lock(self.test_file, self.session1)
        locking.acquire_lock(self.test_file2, self.session2)

        # Make first lock stale
        with locking.get_db_connection() as conn:
            cursor = conn.cursor()
            stale_time = datetime.now(timezone.utc) - timedelta(seconds=locking.LOCK_TIMEOUT_SECONDS + 10)
            cursor.execute("""
                UPDATE locks
                SET updated_at = ?
                WHERE file_path = ?
            """, (stale_time.isoformat(), self.test_file))

        # Purge stale locks
        purged_count = locking.purge_stale_locks()
        self.assertEqual(purged_count, 1, "Should purge exactly one stale lock")

        # Verify only fresh lock remains
        active_locks = locking.get_all_active_locks()
        self.assertNotIn(self.test_file, active_locks)
        self.assertIn(self.test_file2, active_locks)

    def test_get_all_active_locks(self):
        """Test retrieving all active locks."""
        # Create multiple locks
        locking.acquire_lock(self.test_file, self.session1)
        locking.acquire_lock(self.test_file2, self.session2)

        # Get all active locks
        active_locks = locking.get_all_active_locks()

        self.assertEqual(len(active_locks), 2)
        self.assertEqual(active_locks[self.test_file], self.session1)
        self.assertEqual(active_locks[self.test_file2], self.session2)

    def test_get_all_active_locks_excludes_stale(self):
        """Test that get_all_active_locks excludes stale locks."""
        # Create locks
        locking.acquire_lock(self.test_file, self.session1)
        locking.acquire_lock(self.test_file2, self.session2)

        # Make first lock stale
        with locking.get_db_connection() as conn:
            cursor = conn.cursor()
            stale_time = datetime.now(timezone.utc) - timedelta(seconds=locking.LOCK_TIMEOUT_SECONDS + 10)
            cursor.execute("""
                UPDATE locks
                SET updated_at = ?
                WHERE file_path = ?
            """, (stale_time.isoformat(), self.test_file))

        # Get active locks
        active_locks = locking.get_all_active_locks()

        # Only fresh lock should be returned
        self.assertEqual(len(active_locks), 1)
        self.assertNotIn(self.test_file, active_locks)
        self.assertIn(self.test_file2, active_locks)

    def test_check_lock_not_locked(self):
        """Test checking a file that is not locked."""
        result = locking.check_lock(self.test_file, self.session1)
        self.assertFalse(result["is_locked"])

    def test_check_lock_locked_by_self(self):
        """Test checking a file locked by same session."""
        locking.acquire_lock(self.test_file, self.session1)

        result = locking.check_lock(self.test_file, self.session1)
        self.assertFalse(result["is_locked"], "File should not be 'locked' for owner session")

    def test_check_lock_locked_by_other(self):
        """Test checking a file locked by another session."""
        locking.acquire_lock(self.test_file, self.session1)

        result = locking.check_lock(self.test_file, self.session2)
        self.assertTrue(result["is_locked"], "File should be locked for different session")

    def test_multiple_files_multiple_sessions(self):
        """Test complex scenario with multiple files and sessions."""
        # Session 1 locks file 1
        locking.acquire_lock(self.test_file, self.session1)

        # Session 2 locks file 2
        locking.acquire_lock(self.test_file2, self.session2)

        # Session 1 cannot lock file 2
        result = locking.acquire_lock(self.test_file2, self.session1)
        self.assertFalse(result)

        # Session 2 cannot lock file 1
        result = locking.acquire_lock(self.test_file, self.session2)
        self.assertFalse(result)

        # Both can refresh their own locks
        self.assertTrue(locking.acquire_lock(self.test_file, self.session1))
        self.assertTrue(locking.acquire_lock(self.test_file2, self.session2))

        # Both release their locks
        locking.release_lock(self.test_file, self.session1)
        locking.release_lock(self.test_file2, self.session2)

        # Now both can acquire each other's former locks
        self.assertTrue(locking.acquire_lock(self.test_file2, self.session1))
        self.assertTrue(locking.acquire_lock(self.test_file, self.session2))

    def test_concurrent_lock_attempts(self):
        """Test that concurrent lock attempts are handled correctly."""
        # This simulates what happens when two heartbeats arrive simultaneously

        # Session 1 acquires lock
        result1 = locking.acquire_lock(self.test_file, self.session1)
        self.assertTrue(result1)

        # Session 2 tries immediately after
        result2 = locking.acquire_lock(self.test_file, self.session2)
        self.assertFalse(result2, "Concurrent acquisition should fail")

        # Session 1 can still refresh
        result1_refresh = locking.acquire_lock(self.test_file, self.session1)
        self.assertTrue(result1_refresh)


if __name__ == '__main__':
    unittest.main()
