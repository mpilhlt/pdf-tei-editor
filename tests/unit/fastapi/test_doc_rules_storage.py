"""
Unit tests for DocumentRulesStore.

@testCovers fastapi_app/lib/doc_rules/storage.py
"""

import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore


class TestDocumentRulesStore(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db = DatabaseManager(Path(self.temp_dir.name) / "test.db")
        self.store = DocumentRulesStore(self.db)

    def tearDown(self):
        self.temp_dir.cleanup()

    def _create(self, owner="alice", note="my note", text="override text"):
        return self.store.create_override(
            kind="interpretation-ref",
            resource_key="https://example.com/rules.md",
            owner=owner,
            note=note,
            text=text,
            format="markdown",
            base_url="https://example.com/rules.md",
            base_hash="deadbeef",
        )

    def test_create_and_get_override(self):
        created = self._create()
        fetched = self.store.get_override(created["id"])
        self.assertEqual(fetched["note"], "my note")
        self.assertEqual(fetched["text"], "override text")
        self.assertEqual(fetched["owner"], "alice")

    def test_list_overrides_scoped_to_owner_kind_and_key(self):
        self._create(owner="alice")
        self._create(owner="bob")
        alice_overrides = self.store.list_overrides("interpretation-ref", "https://example.com/rules.md", "alice")
        self.assertEqual(len(alice_overrides), 1)
        self.assertEqual(alice_overrides[0]["owner"], "alice")

    def test_update_override_owner_only(self):
        created = self._create(owner="alice")
        updated = self.store.update_override(created["id"], "alice", note="new note", text=None)
        self.assertEqual(updated["note"], "new note")
        self.assertEqual(updated["text"], "override text")  # unchanged

        rejected = self.store.update_override(created["id"], "bob", note="hijack", text=None)
        self.assertIsNone(rejected)

    def test_update_nonexistent_override_returns_none(self):
        self.assertIsNone(self.store.update_override("no-such-id", "alice", note="x", text=None))

    def test_delete_override_owner_only(self):
        created = self._create(owner="alice")
        self.assertFalse(self.store.delete_override(created["id"], "bob"))
        self.assertTrue(self.store.delete_override(created["id"], "alice"))
        self.assertIsNone(self.store.get_override(created["id"]))

    def test_delete_nonexistent_override_returns_false(self):
        self.assertFalse(self.store.delete_override("no-such-id", "alice"))

    def test_selection_roundtrip(self):
        created = self._create(owner="alice")
        self.assertIsNone(self.store.get_selection("interpretation-ref", "https://example.com/rules.md", "alice"))

        self.store.set_selection("interpretation-ref", "https://example.com/rules.md", "alice", created["id"])
        self.assertEqual(
            self.store.get_selection("interpretation-ref", "https://example.com/rules.md", "alice"),
            created["id"],
        )

        self.store.set_selection("interpretation-ref", "https://example.com/rules.md", "alice", None)
        self.assertIsNone(self.store.get_selection("interpretation-ref", "https://example.com/rules.md", "alice"))

    def test_deleting_selected_override_clears_selection(self):
        created = self._create(owner="alice")
        self.store.set_selection("interpretation-ref", "https://example.com/rules.md", "alice", created["id"])
        self.store.delete_override(created["id"], "alice")
        self.assertIsNone(self.store.get_selection("interpretation-ref", "https://example.com/rules.md", "alice"))

    def test_get_selected_override_text_falls_back_to_none(self):
        self._create(owner="alice")
        self.assertIsNone(
            self.store.get_selected_override_text("interpretation-ref", "https://example.com/rules.md", "alice")
        )

    def test_get_selected_override_text_returns_selected_text(self):
        created = self._create(owner="alice", text="override text")
        self.store.set_selection("interpretation-ref", "https://example.com/rules.md", "alice", created["id"])
        self.assertEqual(
            self.store.get_selected_override_text("interpretation-ref", "https://example.com/rules.md", "alice"),
            "override text",
        )

    def test_reset_selection_keeps_overrides(self):
        created = self._create(owner="alice")
        self.store.set_selection("interpretation-ref", "https://example.com/rules.md", "alice", created["id"])
        self.store.reset_selection("alice", [("interpretation-ref", "https://example.com/rules.md")])
        self.assertIsNone(self.store.get_selection("interpretation-ref", "https://example.com/rules.md", "alice"))
        self.assertIsNotNone(self.store.get_override(created["id"]))

    def test_rekey_override_moves_override_and_its_selection(self):
        old_key = "https://example.com/rules.md#L5-L8"
        new_key = "https://example.com/rules.md#section-a"
        first = self.store.create_override("interpretation-ref", old_key, "alice", "", "a", "markdown", old_key, "h")
        second = self.store.create_override("interpretation-ref", old_key, "alice", "", "b", "markdown", old_key, "h")
        self.store.set_selection("interpretation-ref", old_key, "alice", first["id"])

        self.assertTrue(self.store.rekey_override(first["id"], new_key))

        self.assertEqual([o["id"] for o in self.store.list_overrides("interpretation-ref", new_key, "alice")], [first["id"]])
        self.assertEqual([o["id"] for o in self.store.list_overrides("interpretation-ref", old_key, "alice")], [second["id"]])
        self.assertEqual(self.store.get_selection("interpretation-ref", new_key, "alice"), first["id"])
        self.assertIsNone(self.store.get_selection("interpretation-ref", old_key, "alice"))
        self.assertFalse(self.store.rekey_override("no-such-id", new_key))

    def test_rekey_override_to_its_current_key_keeps_selection(self):
        # A second worker's startup migration may rekey a row another worker already moved
        key = "https://example.com/rules.md#section-a"
        override = self.store.create_override("interpretation-ref", key, "alice", "", "a", "markdown", key, "h")
        self.store.set_selection("interpretation-ref", key, "alice", override["id"])
        self.assertFalse(self.store.rekey_override(override["id"], key))
        self.assertEqual(self.store.get_selection("interpretation-ref", key, "alice"), override["id"])

    def test_rekey_override_keeps_existing_selection_under_new_key(self):
        old_key = "https://example.com/rules.md#L5-L8"
        new_key = "https://example.com/rules.md#section-a"
        legacy = self.store.create_override("interpretation-ref", old_key, "alice", "", "old", "markdown", old_key, "h")
        current = self.store.create_override("interpretation-ref", new_key, "alice", "", "new", "markdown", new_key, "h")
        self.store.set_selection("interpretation-ref", old_key, "alice", legacy["id"])
        self.store.set_selection("interpretation-ref", new_key, "alice", current["id"])

        self.store.rekey_override(legacy["id"], new_key)

        self.assertEqual(self.store.get_override(legacy["id"])["resource_key"], new_key)
        self.assertEqual(self.store.get_selection("interpretation-ref", new_key, "alice"), current["id"])
        self.assertIsNone(self.store.get_selection("interpretation-ref", old_key, "alice"))
