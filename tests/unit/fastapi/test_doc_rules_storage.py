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

    def test_migrate_resource_key_moves_overrides_and_selection(self):
        old_key = "https://example.com/rules.md#L5-L8"
        new_key = "https://example.com/rules.md#section-a"
        first = self.store.create_override("interpretation-ref", old_key, "alice", "", "a", "markdown", old_key, "h")
        self.store.create_override("interpretation-ref", old_key, "alice", "", "b", "markdown", old_key, "h")
        self.store.create_override("interpretation-ref", old_key, "bob", "", "c", "markdown", old_key, "h")
        self.store.set_selection("interpretation-ref", old_key, "alice", first["id"])

        moved = self.store.migrate_resource_key("interpretation-ref", old_key, new_key)

        self.assertEqual(moved, 4)  # three overrides plus alice's selection
        self.assertEqual(self.store.list_overrides("interpretation-ref", old_key, "alice"), [])
        self.assertEqual(len(self.store.list_overrides("interpretation-ref", new_key, "alice")), 2)
        self.assertEqual(len(self.store.list_overrides("interpretation-ref", new_key, "bob")), 1)
        self.assertIsNone(self.store.get_selection("interpretation-ref", old_key, "alice"))
        self.assertEqual(self.store.get_selection("interpretation-ref", new_key, "alice"), first["id"])
        self.assertEqual(self.store.migrate_resource_key("interpretation-ref", old_key, new_key), 0)
        self.assertEqual(self.store.migrate_resource_key("interpretation-ref", new_key, new_key), 0)

    def test_migrate_resource_key_skips_owner_who_already_has_new_key_rows(self):
        old_key = "https://example.com/rules.md#L5-L8"
        new_key = "https://example.com/rules.md#section-a"
        legacy = self.store.create_override("interpretation-ref", old_key, "alice", "", "old", "markdown", old_key, "h")
        current = self.store.create_override("interpretation-ref", new_key, "alice", "", "new", "markdown", new_key, "h")
        self.store.set_selection("interpretation-ref", new_key, "alice", current["id"])
        self.store.create_override("interpretation-ref", old_key, "bob", "", "bob's", "markdown", old_key, "h")

        moved = self.store.migrate_resource_key("interpretation-ref", old_key, new_key)

        self.assertEqual(moved, 1)  # only bob's override
        self.assertEqual([o["id"] for o in self.store.list_overrides("interpretation-ref", old_key, "alice")], [legacy["id"]])
        self.assertEqual([o["id"] for o in self.store.list_overrides("interpretation-ref", new_key, "alice")], [current["id"]])
        self.assertEqual(self.store.get_selection("interpretation-ref", new_key, "alice"), current["id"])
        self.assertEqual(len(self.store.list_overrides("interpretation-ref", new_key, "bob")), 1)
