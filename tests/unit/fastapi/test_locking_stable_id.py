"""
Unit tests for locking system using stable_id.

Tests that locks use stable_id instead of content hash,
eliminating the need for lock transfers.

@testCovers fastapi_app/lib/locking.py
@testCovers fastapi_app/lib/migrations/versions/m001_locks_file_id.py
"""

import unittest
import tempfile
import sqlite3
import logging
from pathlib import Path
from datetime import datetime, timezone, timedelta

from fastapi_app.lib.locking import (
    acquire_lock,
    release_lock,
    check_lock,
    get_all_active_locks,
    get_locked_file_ids,
    init_locks_db,
    LOCK_TIMEOUT_SECONDS
)


class TestLockingStableId(unittest.TestCase):
    """Test locking system with stable_id."""

    def setUp(self):
        """Create temporary database for each test."""
        self.temp_dir = tempfile.mkdtemp()
        self.db_dir = Path(self.temp_dir)
        self.logger = logging.getLogger("test_locking")
        self.logger.setLevel(logging.DEBUG)

        # Initialize locks database
        init_locks_db(self.db_dir, self.logger)

    def tearDown(self):
        """Clean up temporary database."""
        import shutil
        if self.db_dir.exists():
            shutil.rmtree(self.db_dir)

    def test_acquire_lock_with_stable_id(self):
        """Test acquiring lock using stable_id."""
        stable_id = "test123"
        session_id = "session-abc"

        result = acquire_lock(stable_id, session_id, self.db_dir, self.logger)

        self.assertTrue(result)

        # Verify lock is stored with stable_id
        locks = get_all_active_locks(self.db_dir, self.logger)
        self.assertIn(stable_id, locks)
        self.assertEqual(locks[stable_id], session_id)

    def test_lock_persists_across_content_changes(self):
        """
        Test that lock remains valid when content changes.

        This is the key improvement: stable_id never changes,
        so locks don't need to be transferred.
        """
        stable_id = "file-abc123"
        session_id = "session-xyz"

        # Acquire lock
        acquire_lock(stable_id, session_id, self.db_dir, self.logger)

        # Simulate content change (in the old system, content hash would change)
        # But stable_id remains the same!

        # Lock should still be valid
        lock_status = check_lock(stable_id, session_id, self.db_dir, self.logger)
        self.assertFalse(lock_status['is_locked'])  # Not locked by ANOTHER session

        # Should be able to refresh the lock
        result = acquire_lock(stable_id, session_id, self.db_dir, self.logger)
        self.assertTrue(result)

    def test_lock_refresh_with_stable_id(self):
        """Test refreshing lock using stable_id."""
        stable_id = "file-xyz789"
        session_id = "session-123"

        # Acquire initial lock
        acquire_lock(stable_id, session_id, self.db_dir, self.logger)

        # Get initial timestamp
        with sqlite3.connect(str(self.db_dir / "locks.db")) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute("SELECT updated_at FROM locks WHERE file_id = ?", (stable_id,))
            row = cursor.fetchone()
            initial_time = row['updated_at']

        # Wait a moment and refresh (need at least 1 second for timestamp to change)
        import time
        time.sleep(1.1)

        acquire_lock(stable_id, session_id, self.db_dir, self.logger)

        # Verify timestamp was updated
        with sqlite3.connect(str(self.db_dir / "locks.db")) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute("SELECT updated_at FROM locks WHERE file_id = ?", (stable_id,))
            row = cursor.fetchone()
            updated_time = row['updated_at']

        self.assertGreater(updated_time, initial_time)

    def test_release_lock_with_stable_id(self):
        """Test releasing lock using stable_id."""
        stable_id = "file-release-test"
        session_id = "session-rel"

        # Acquire and release
        acquire_lock(stable_id, session_id, self.db_dir, self.logger)
        result = release_lock(stable_id, session_id, self.db_dir, self.logger)

        self.assertEqual(result['status'], 'success')
        self.assertEqual(result['action'], 'released')

        # Verify lock is gone
        locks = get_all_active_locks(self.db_dir, self.logger)
        self.assertNotIn(stable_id, locks)

    def test_check_lock_with_stable_id(self):
        """Test checking lock status using stable_id."""
        stable_id = "file-check-test"
        session_a = "session-a"
        session_b = "session-b"

        # No lock initially
        status = check_lock(stable_id, session_a, self.db_dir, self.logger)
        self.assertFalse(status['is_locked'])

        # Acquire lock with session A
        acquire_lock(stable_id, session_a, self.db_dir, self.logger)

        # Check from session B (should show locked)
        status = check_lock(stable_id, session_b, self.db_dir, self.logger)
        self.assertTrue(status['is_locked'])
        self.assertEqual(status['locked_by'], session_a)

        # Check from session A (should show not locked)
        status = check_lock(stable_id, session_a, self.db_dir, self.logger)
        self.assertFalse(status['is_locked'])

    def test_get_locked_file_ids_returns_stable_ids(self):
        """Test get_locked_file_ids returns stable_ids directly."""
        stable_id_1 = "file-abc"
        stable_id_2 = "file-def"
        session_id = "session-test"

        # Acquire locks
        acquire_lock(stable_id_1, session_id, self.db_dir, self.logger)
        acquire_lock(stable_id_2, session_id, self.db_dir, self.logger)

        # Get locked IDs
        locked_ids = get_locked_file_ids(self.db_dir, self.logger, session_id=session_id)

        # Should return stable_ids directly
        self.assertEqual(set(locked_ids), {stable_id_1, stable_id_2})

    def test_stale_lock_takeover_with_stable_id(self):
        """Test taking over stale locks using stable_id."""
        stable_id = "file-stale"
        session_a = "session-old"
        session_b = "session-new"

        # Acquire lock with session A
        acquire_lock(stable_id, session_a, self.db_dir, self.logger)

        # Manually set lock to be stale
        stale_time = datetime.now(timezone.utc) - timedelta(seconds=LOCK_TIMEOUT_SECONDS + 10)
        with sqlite3.connect(str(self.db_dir / "locks.db")) as conn:
            conn.execute(
                "UPDATE locks SET updated_at = ? WHERE file_id = ?",
                (stale_time.isoformat(), stable_id)
            )
            conn.commit()

        # Session B should be able to take over
        result = acquire_lock(stable_id, session_b, self.db_dir, self.logger)
        self.assertTrue(result)

        # Verify lock is now owned by session B
        locks = get_all_active_locks(self.db_dir, self.logger)
        self.assertEqual(locks[stable_id], session_b)

    def test_concurrent_lock_attempts(self):
        """Test concurrent lock attempts use stable_id correctly."""
        stable_id = "file-concurrent"
        session_a = "session-first"
        session_b = "session-second"

        # Session A acquires lock
        result_a = acquire_lock(stable_id, session_a, self.db_dir, self.logger)
        self.assertTrue(result_a)

        # Session B tries to acquire same lock (should fail)
        result_b = acquire_lock(stable_id, session_b, self.db_dir, self.logger)
        self.assertFalse(result_b)

        # Release from A
        release_lock(stable_id, session_a, self.db_dir, self.logger)

        # Now B can acquire
        result_b2 = acquire_lock(stable_id, session_b, self.db_dir, self.logger)
        self.assertTrue(result_b2)

    def test_locks_table_schema_uses_file_id(self):
        """Test locks table uses file_id column (not file_hash)."""
        with sqlite3.connect(str(self.db_dir / "locks.db")) as conn:
            cursor = conn.execute("PRAGMA table_info(locks)")
            columns = {row[1] for row in cursor.fetchall()}

            # Should have file_id column
            self.assertIn('file_id', columns)

            # Should NOT have file_hash column
            self.assertNotIn('file_hash', columns)

    def test_lock_idempotency(self):
        """Test acquiring same lock multiple times is idempotent."""
        stable_id = "file-idempotent"
        session_id = "session-test"

        # Acquire multiple times
        result1 = acquire_lock(stable_id, session_id, self.db_dir, self.logger)
        result2 = acquire_lock(stable_id, session_id, self.db_dir, self.logger)
        result3 = acquire_lock(stable_id, session_id, self.db_dir, self.logger)

        self.assertTrue(result1)
        self.assertTrue(result2)
        self.assertTrue(result3)

        # Should still be only one lock
        locks = get_all_active_locks(self.db_dir, self.logger)
        self.assertEqual(len([k for k in locks if k == stable_id]), 1)

    def test_release_nonexistent_lock_is_idempotent(self):
        """Test releasing nonexistent lock is safe."""
        stable_id = "file-nonexistent"
        session_id = "session-test"

        # Release lock that doesn't exist
        result = release_lock(stable_id, session_id, self.db_dir, self.logger)

        self.assertEqual(result['status'], 'success')
        self.assertEqual(result['action'], 'already_released')

    def test_release_others_lock_raises_error(self):
        """Test releasing another session's lock raises error."""
        stable_id = "file-ownership"
        session_a = "session-owner"
        session_b = "session-intruder"

        # Session A acquires lock
        acquire_lock(stable_id, session_a, self.db_dir, self.logger)

        # Session B tries to release (should fail)
        with self.assertRaises(RuntimeError) as context:
            release_lock(stable_id, session_b, self.db_dir, self.logger)

        self.assertIn("attempted to release a lock owned by", str(context.exception))


if __name__ == '__main__':
    unittest.main()
