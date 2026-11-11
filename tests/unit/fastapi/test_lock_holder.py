"""
Unit tests for describing the holder of a lock in the 423 response of acquire_lock.

@testCovers fastapi_app/lib/core/locking.py
@testCovers fastapi_app/routers/files_locks.py
"""

import unittest
from unittest.mock import MagicMock

from fastapi_app.lib.core import locking
from fastapi_app.lib.core.locking import register_lock_holder, get_lock_holder_notice
from fastapi_app.routers.files_locks import describe_lock_holder


class TestLockHolder(unittest.TestCase):
    """register_lock_holder(), get_lock_holder_notice() and describe_lock_holder()."""

    def setUp(self):
        self._saved_notices = dict(locking._lock_holder_notices)
        locking._lock_holder_notices.clear()
        self.session_manager = MagicMock()
        self.session_manager.get_username_by_session_id.side_effect = {
            "alice-session": "alice",
            "bob-session": "bob",
        }.get

    def tearDown(self):
        locking._lock_holder_notices.clear()
        locking._lock_holder_notices.update(self._saved_notices)

    def test_notice_of_registered_prefix(self):
        register_lock_holder("job:", "Locked by a job")
        register_lock_holder("job:special:", "Locked by a special job")
        self.assertEqual(get_lock_holder_notice("job:123"), "Locked by a job")
        self.assertEqual(get_lock_holder_notice("job:special:1"), "Locked by a special job")
        self.assertIsNone(get_lock_holder_notice("alice-session"))

    def test_empty_prefix_is_rejected(self):
        with self.assertRaises(ValueError):
            register_lock_holder("", "Locked")

    def test_process_holder(self):
        register_lock_holder("auto-annotation:", "This document is locked while its annotations are corrected automatically")
        detail = describe_lock_holder("auto-annotation:42", "alice", self.session_manager)
        self.assertEqual(detail.holder, "process")
        self.assertIsNone(detail.username)
        self.assertEqual(detail.message, "This document is locked while its annotations are corrected automatically")

    def test_own_session(self):
        detail = describe_lock_holder("alice-session", "alice", self.session_manager)
        self.assertEqual(detail.holder, "own_session")
        self.assertEqual(detail.username, "alice")
        self.assertIn("another window", detail.message)

    def test_other_user(self):
        detail = describe_lock_holder("bob-session", "alice", self.session_manager)
        self.assertEqual(detail.holder, "user")
        self.assertEqual(detail.username, "bob")
        self.assertEqual(detail.message, "This document is being edited by bob")

    def test_unknown_holder(self):
        for holder_id in ("expired-session", None):
            detail = describe_lock_holder(holder_id, "alice", self.session_manager)
            self.assertEqual(detail.holder, "user")
            self.assertIsNone(detail.username)
            self.assertEqual(detail.message, "This document is being edited by another user")
            self.assertEqual(detail.model_dump()["code"], "locked")


if __name__ == "__main__":
    unittest.main()
