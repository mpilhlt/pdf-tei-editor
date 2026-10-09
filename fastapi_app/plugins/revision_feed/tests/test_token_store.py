"""
Unit tests for the revision feed plugin's token store.

@testCovers fastapi_app/plugins/revision_feed/token_store.py
"""

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch

from fastapi_app.plugins.revision_feed import token_store
from fastapi_app.plugins.revision_feed.token_store import (
    get_or_create_token,
    regenerate_token,
    resolve_token,
)


class TestTokenStore(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.plugins_data_dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_get_or_create_token_creates_new_token(self):
        token = get_or_create_token("alice", self.plugins_data_dir)
        self.assertTrue(len(token) > 20)

    def test_get_or_create_token_is_stable(self):
        first = get_or_create_token("alice", self.plugins_data_dir)
        second = get_or_create_token("alice", self.plugins_data_dir)
        self.assertEqual(first, second)

    def test_different_users_get_different_tokens(self):
        alice_token = get_or_create_token("alice", self.plugins_data_dir)
        bob_token = get_or_create_token("bob", self.plugins_data_dir)
        self.assertNotEqual(alice_token, bob_token)

    def test_resolve_token_returns_username(self):
        token = get_or_create_token("alice", self.plugins_data_dir)
        self.assertEqual(resolve_token(token, self.plugins_data_dir), "alice")

    def test_resolve_unknown_token_returns_none(self):
        self.assertIsNone(resolve_token("not-a-real-token", self.plugins_data_dir))

    def test_regenerate_token_invalidates_old_token(self):
        old_token = get_or_create_token("alice", self.plugins_data_dir)
        new_token = regenerate_token("alice", self.plugins_data_dir)

        self.assertNotEqual(old_token, new_token)
        self.assertIsNone(resolve_token(old_token, self.plugins_data_dir))
        self.assertEqual(resolve_token(new_token, self.plugins_data_dir), "alice")


class TestTokenStoreLocking(unittest.TestCase):
    """Verify the read-modify-write operations actually go through the
    thread lock + OS file lock, rather than relying on a flaky real
    concurrency/threading test. This proves the locking mechanism from
    fastapi_app/plugins/revision_feed/token_store.py is wired up, mirroring
    the thread-lock + file-lock pattern used for users.json/config.json
    elsewhere in the backend.
    """

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.plugins_data_dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_get_or_create_token_acquires_thread_lock(self):
        mock_lock = MagicMock()
        with patch.object(token_store, "_lock", mock_lock):
            token_store.get_or_create_token("alice", self.plugins_data_dir)

        mock_lock.__enter__.assert_called_once()
        mock_lock.__exit__.assert_called_once()

    def test_get_or_create_token_acquires_file_lock(self):
        with patch.object(token_store, "_lock_file") as mock_lock_file, \
                patch.object(token_store, "_unlock_file") as mock_unlock_file:
            token_store.get_or_create_token("alice", self.plugins_data_dir)

        mock_lock_file.assert_called_once()
        mock_unlock_file.assert_called_once()

    def test_regenerate_token_acquires_thread_lock(self):
        mock_lock = MagicMock()
        with patch.object(token_store, "_lock", mock_lock):
            token_store.regenerate_token("alice", self.plugins_data_dir)

        mock_lock.__enter__.assert_called_once()
        mock_lock.__exit__.assert_called_once()

    def test_regenerate_token_acquires_file_lock(self):
        with patch.object(token_store, "_lock_file") as mock_lock_file, \
                patch.object(token_store, "_unlock_file") as mock_unlock_file:
            token_store.regenerate_token("alice", self.plugins_data_dir)

        mock_lock_file.assert_called_once()
        mock_unlock_file.assert_called_once()

    def test_file_lock_is_released_even_if_mutation_raises(self):
        """A failure mid-mutation must not leave the OS file lock held,
        or every subsequent request would deadlock against it."""

        def _raise(tokens):
            raise RuntimeError("boom")

        with patch.object(token_store, "_unlock_file") as mock_unlock_file:
            with self.assertRaises(RuntimeError):
                token_store._with_locked_tokens(self.plugins_data_dir, _raise)

        mock_unlock_file.assert_called_once()

    def test_resolve_token_acquires_thread_lock_but_not_file_lock(self):
        token = token_store.get_or_create_token("alice", self.plugins_data_dir)

        mock_lock = MagicMock()
        with patch.object(token_store, "_lock", mock_lock), \
                patch.object(token_store, "_lock_file") as mock_lock_file:
            token_store.resolve_token(token, self.plugins_data_dir)

        mock_lock.__enter__.assert_called_once()
        mock_lock_file.assert_not_called()


if __name__ == "__main__":
    unittest.main()
