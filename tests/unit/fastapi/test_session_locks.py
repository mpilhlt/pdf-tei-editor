"""
Unit tests for releasing the file locks of ended sessions (issue #851).

A lock is held by a session. When the session ends (logout, removal, expiry), nobody can refresh or
release the lock anymore, and the user who held it gets "being edited by another user" after logging in again.

@testCovers fastapi_app/lib/core/locking.py
@testCovers fastapi_app/lib/core/sessions.py
@testCovers fastapi_app/api/auth.py
"""

import gc
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.api import auth
from fastapi_app.lib.core.db_utils import close_all_connections, get_connection
from fastapi_app.lib.core.locking import acquire_lock, check_lock, get_locked_file_ids, release_session_locks
from fastapi_app.lib.core.sessions import SessionManager
from fastapi_app.lib.utils.logging_utils import get_logger

logger = get_logger(__name__)


class SessionLocksTestCase(unittest.TestCase):
    """Temporary db directory with a session manager and two sessions of the same user."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_dir = Path(self.temp_dir.name)
        self.session_mgr = SessionManager(self.db_dir)
        self.session_id = self.session_mgr.create_session("alice")

    def tearDown(self) -> None:
        close_all_connections()
        gc.collect()
        self.temp_dir.cleanup()

    def _locks_of(self, session_id: str) -> list[str]:
        return get_locked_file_ids(self.db_dir, logger, session_id=session_id)


class TestReleaseSessionLocks(SessionLocksTestCase):
    """release_session_locks() and the session deletions of SessionManager."""

    def test_releases_only_the_locks_of_the_given_sessions(self) -> None:
        other = self.session_mgr.create_session("bob")
        self.assertTrue(acquire_lock("file-a", self.session_id, self.db_dir, logger))
        self.assertTrue(acquire_lock("file-b", self.session_id, self.db_dir, logger))
        self.assertTrue(acquire_lock("file-c", other, self.db_dir, logger))

        released = release_session_locks([self.session_id], self.db_dir, logger)

        self.assertEqual(sorted(released), ["file-a", "file-b"])
        self.assertEqual(self._locks_of(self.session_id), [])
        self.assertEqual(self._locks_of(other), ["file-c"])
        self.assertEqual(release_session_locks([], self.db_dir, logger), [])

    def test_delete_session_releases_its_locks(self) -> None:
        self.assertTrue(acquire_lock("file-a", self.session_id, self.db_dir, logger))
        self.session_mgr.delete_session(self.session_id)

        new_session = self.session_mgr.create_session("alice")
        self.assertFalse(check_lock("file-a", new_session, self.db_dir, logger)["is_locked"])
        self.assertTrue(acquire_lock("file-a", new_session, self.db_dir, logger))

    def test_delete_all_user_sessions_releases_their_locks(self) -> None:
        second = self.session_mgr.create_session("alice")
        other = self.session_mgr.create_session("bob")
        acquire_lock("file-a", self.session_id, self.db_dir, logger)
        acquire_lock("file-b", second, self.db_dir, logger)
        acquire_lock("file-c", other, self.db_dir, logger)

        self.session_mgr.delete_all_user_sessions("alice")

        self.assertEqual(get_locked_file_ids(self.db_dir, logger), ["file-c"])

    def test_delete_token_sessions_releases_their_locks(self) -> None:
        token_session = self.session_mgr.create_session("alice", token_id="tok1")
        acquire_lock("file-a", token_session, self.db_dir, logger)
        acquire_lock("file-b", self.session_id, self.db_dir, logger)

        self.session_mgr.delete_token_sessions("tok1")

        self.assertEqual(get_locked_file_ids(self.db_dir, logger), ["file-b"])

    def test_cleanup_expired_sessions_releases_their_locks(self) -> None:
        acquire_lock("file-a", self.session_id, self.db_dir, logger)
        fresh = self.session_mgr.create_session("bob")
        acquire_lock("file-b", fresh, self.db_dir, logger)
        conn = get_connection(self.session_mgr.db_path)
        conn.execute("UPDATE sessions SET last_access = ? WHERE session_id = ?", (time.time() - 7200, self.session_id))
        conn.commit()

        self.assertEqual(self.session_mgr.cleanup_expired_sessions(3600), 1)

        self.assertEqual(get_locked_file_ids(self.db_dir, logger), ["file-b"])


class TestLogoutReleasesLocks(SessionLocksTestCase):
    """POST /auth/logout releases the locks of the session, so the user can edit the file after logging in again."""

    def setUp(self) -> None:
        super().setUp()
        settings = SimpleNamespace(db_dir=self.db_dir)
        self.patchers = [
            patch("fastapi_app.api.auth.get_settings", return_value=settings),
            patch("fastapi_app.api.auth.get_session_manager", return_value=self.session_mgr),
        ]
        for patcher in self.patchers:
            patcher.start()
        app = FastAPI()
        app.include_router(auth.router)
        self.client = TestClient(app)

    def tearDown(self) -> None:
        for patcher in self.patchers:
            patcher.stop()
        super().tearDown()

    def test_logout_releases_locks(self) -> None:
        self.assertTrue(acquire_lock("file-a", self.session_id, self.db_dir, logger))

        response = self.client.post("/auth/logout", headers={"X-Session-ID": self.session_id})

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(self.session_mgr.get_session(self.session_id))
        new_session = self.session_mgr.create_session("alice")
        self.assertFalse(check_lock("file-a", new_session, self.db_dir, logger)["is_locked"])
        self.assertTrue(acquire_lock("file-a", new_session, self.db_dir, logger))


if __name__ == "__main__":
    unittest.main()
