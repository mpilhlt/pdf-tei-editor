"""
Unit tests for the recent documents edit store.

@testCovers fastapi_app/plugins/recent_documents/edit_store.py
"""

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from fastapi_app.plugins.recent_documents import edit_store


def _at(day: int) -> datetime:
    return datetime(2026, 10, day, tzinfo=timezone.utc)


class TestEditStore(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.dir = Path(self.temp_dir.name)

    def test_returns_edits_newest_first(self):
        edit_store.record_edit("alice", "a", self.dir, _at(1))
        edit_store.record_edit("alice", "b", self.dir, _at(3))
        edit_store.record_edit("alice", "c", self.dir, _at(2))
        edit_store.record_edit("bob", "d", self.dir, _at(4))

        self.assertEqual([sid for sid, _ in edit_store.get_user_edits("alice", self.dir)], ["b", "c", "a"])
        self.assertEqual(edit_store.get_user_edits("carol", self.dir), [])

    def test_keeps_the_newest_timestamp_of_a_file(self):
        edit_store.record_edit("alice", "a", self.dir, _at(5))
        edit_store.record_edit("alice", "a", self.dir, _at(2))
        self.assertEqual(edit_store.get_user_edits("alice", self.dir), [("a", _at(5).isoformat())])

    def test_caps_entries_per_user(self):
        with mock.patch.object(edit_store, "MAX_ENTRIES_PER_USER", 2):
            for day in range(1, 5):
                edit_store.record_edit("alice", f"f{day}", self.dir, _at(day))
        self.assertEqual([sid for sid, _ in edit_store.get_user_edits("alice", self.dir)], ["f4", "f3"])

    def test_seeds_only_once(self):
        self.assertFalse(edit_store.is_seeded(self.dir))
        self.assertTrue(edit_store.seed_edits({"alice": {"a": _at(1).isoformat()}}, self.dir))
        self.assertTrue(edit_store.is_seeded(self.dir))
        self.assertFalse(edit_store.seed_edits({"alice": {"b": _at(2).isoformat()}}, self.dir))
        self.assertEqual([sid for sid, _ in edit_store.get_user_edits("alice", self.dir)], ["a"])

    def test_seeding_does_not_override_newer_edits(self):
        edit_store.record_edit("alice", "a", self.dir, _at(9))
        edit_store.seed_edits({"alice": {"a": _at(1).isoformat()}}, self.dir)
        self.assertEqual(edit_store.get_user_edits("alice", self.dir), [("a", _at(9).isoformat())])

    def test_treats_a_corrupt_file_as_empty(self):
        path = self.dir / "recent_documents" / edit_store.EDITS_FILE_NAME
        path.parent.mkdir(parents=True)
        path.write_text("{not json")
        self.assertEqual(edit_store.get_user_edits("alice", self.dir), [])
        edit_store.record_edit("alice", "a", self.dir, _at(1))
        self.assertEqual(len(edit_store.get_user_edits("alice", self.dir)), 1)


if __name__ == "__main__":
    unittest.main()
