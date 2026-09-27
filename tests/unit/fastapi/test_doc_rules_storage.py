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

    def test_delete_override_owner_only(self):
        created = self._create(owner="alice")
        self.assertFalse(self.store.delete_override(created["id"], "bob"))
        self.assertTrue(self.store.delete_override(created["id"], "alice"))
        self.assertIsNone(self.store.get_override(created["id"]))

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

    def test_reset_selection_keeps_overrides(self):
        created = self._create(owner="alice")
        self.store.set_selection("interpretation-ref", "https://example.com/rules.md", "alice", created["id"])
        self.store.reset_selection("alice", [("interpretation-ref", "https://example.com/rules.md")])
        self.assertIsNone(self.store.get_selection("interpretation-ref", "https://example.com/rules.md", "alice"))
        self.assertIsNotNone(self.store.get_override(created["id"]))
