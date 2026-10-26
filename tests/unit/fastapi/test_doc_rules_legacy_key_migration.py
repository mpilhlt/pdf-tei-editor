"""
Tests for the startup migration of pre-#666 line-range override keys to heading-anchor keys.

@testCovers fastapi_app/lib/doc_rules/legacy_key_migration.py
"""

import tempfile
import unittest
from pathlib import Path
from typing import Literal
from unittest.mock import patch

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.doc_rules.interpretation_ref_kind import legacy_resource_key, selected_rule_override_text
from fastapi_app.lib.doc_rules.legacy_key_migration import (
    migrate_legacy_override_keys,
    start_legacy_override_key_migration,
)
from fastapi_app.lib.doc_rules.resource_key import normalize_resource_key
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore, OverrideRow
from fastapi_app.lib.utils.annotation_rules_utils import AnnotationRuleRef, RuleFetchError

_FETCH_EXCERPT = "fastapi_app.lib.doc_rules.interpretation_ref_kind.fetch_rule_excerpt"
KIND = "interpretation-ref"
GUIDE = "# T\n\n## Citations\nrule\n## Other\nx\n"
SHA_A = "0123456789abcdef0123456789abcdef01234567"
SHA_B = "89abcdef0123456789abcdef0123456789abcdef"


class TestMigrateLegacyOverrideKeys(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = DocumentRulesStore(DatabaseManager(Path(self.temp_dir.name) / "test.db"))

    def tearDown(self):
        self.temp_dir.cleanup()

    def _legacy(self, url: str, text: str, owner: str = "alice", select: bool = True) -> OverrideRow:
        override = self.store.create_override(
            kind=KIND, resource_key=legacy_resource_key(url), owner=owner, note="", text=text,
            format="markdown", base_url=url, base_hash="h",
        )
        if select:
            self.store.set_selection(KIND, legacy_resource_key(url), owner, override["id"])
        return override

    def _key(self, override_id: str) -> str:
        override = self.store.get_override(override_id)
        assert override is not None
        return override["resource_key"]

    def test_folded_category_override_is_moved_and_found_by_reviewer(self):
        human = "https://github.com/o/r/blob/main/guide.md#citations"
        machine = "https://github.com/o/r/blob/main/guide.md#L3-L4"
        self._legacy(machine, "post-645 edit")
        entry: AnnotationRuleRef = {"category": "primary", "refs": [
            {"target": human, "content_type": "markdown", "subtype": "human"},
            {"target": machine, "content_type": "markdown", "subtype": "machine"},
        ]}
        with patch(_FETCH_EXCERPT, return_value=GUIDE):
            self.assertEqual(migrate_legacy_override_keys(self.store), 1)
            self.assertEqual(selected_rule_override_text(self.store, entry, "alice"), "post-645 edit")

    def test_two_ranges_of_one_owner_both_move_and_selection_is_kept(self):
        first = self._legacy("https://github.com/o/r/blob/main/llm.md#L3-L4", "a1")
        second = self._legacy("https://github.com/o/r/blob/main/llm.md#L3-L5", "a2")
        new_key = normalize_resource_key("https://github.com/o/r/blob/main/llm.md#citations")
        with patch(_FETCH_EXCERPT, return_value=GUIDE):
            self.assertEqual(migrate_legacy_override_keys(self.store), 2)
        self.assertEqual(
            {o["id"] for o in self.store.list_overrides(KIND, new_key, "alice")}, {first["id"], second["id"]}
        )
        self.assertEqual(self.store.get_selection(KIND, new_key, "alice"), first["id"])
        for url in ("https://github.com/o/r/blob/main/llm.md#L3-L4", "https://github.com/o/r/blob/main/llm.md#L3-L5"):
            self.assertIsNone(self.store.get_selection(KIND, legacy_resource_key(url), "alice"))

    def test_rows_resolve_against_their_own_pinned_file(self):
        # Both rows share the SHA-stripped legacy key, but line 3 is a different heading in each pinned file
        url_a = f"https://github.com/o/r/blob/{SHA_A}/llm.md#L3-L4"
        url_b = f"https://github.com/o/r/blob/{SHA_B}/llm.md#L3-L4"
        a = self._legacy(url_a, "a", owner="alice")
        b = self._legacy(url_b, "b", owner="bob")
        texts = {
            f"https://github.com/o/r/blob/{SHA_A}/llm.md": "# T\n\n## First\nx\n",
            f"https://github.com/o/r/blob/{SHA_B}/llm.md": "# T\n\n## Second\ny\n",
        }
        with patch(_FETCH_EXCERPT, side_effect=lambda url, *args, **kwargs: texts[url]):
            self.assertEqual(migrate_legacy_override_keys(self.store), 2)
        self.assertEqual(self._key(a["id"]), normalize_resource_key(f"{url_a.partition('#')[0]}#first"))
        self.assertEqual(self._key(b["id"]), normalize_resource_key(f"{url_b.partition('#')[0]}#second"))
        self.assertEqual(self.store.get_selection(KIND, normalize_resource_key("https://github.com/o/r/blob/main/llm.md#second"), "bob"), b["id"])

    def test_fetch_failure_leaves_row_untouched(self):
        url = "https://github.com/o/r/blob/main/llm.md#L3-L4"
        override = self._legacy(url, "a")
        with patch(_FETCH_EXCERPT, side_effect=RuleFetchError("boom")), self.assertLogs(
            "fastapi_app.lib.doc_rules.legacy_key_migration", level="WARNING"
        ):
            self.assertEqual(migrate_legacy_override_keys(self.store), 0)
        self.assertEqual(self._key(override["id"]), legacy_resource_key(url))
        self.assertEqual(self.store.get_selection(KIND, legacy_resource_key(url), "alice"), override["id"])

    def test_row_without_heading_at_start_line_stays(self):
        url = "https://github.com/o/r/blob/main/llm.md#L4-L5"
        override = self._legacy(url, "a")
        with patch(_FETCH_EXCERPT, return_value=GUIDE):
            self.assertEqual(migrate_legacy_override_keys(self.store), 0)
        self.assertEqual(self._key(override["id"]), legacy_resource_key(url))

    def test_second_run_is_a_no_op(self):
        self._legacy("https://github.com/o/r/blob/main/llm.md#L3-L4", "a")
        self.store.create_override(
            kind=KIND, resource_key=normalize_resource_key("https://github.com/o/r/blob/main/llm.md#other"),
            owner="alice", note="", text="t", format="markdown",
            base_url="https://github.com/o/r/blob/main/llm.md#other", base_hash="h",
        )
        with patch(_FETCH_EXCERPT, return_value=GUIDE) as mock_fetch:
            self.assertEqual(migrate_legacy_override_keys(self.store), 1)
            mock_fetch.reset_mock()
            self.assertEqual(migrate_legacy_override_keys(self.store), 0)
        mock_fetch.assert_not_called()

    def test_existing_heading_key_selection_wins_over_moved_one(self):
        url = "https://github.com/o/r/blob/main/llm.md#L3-L4"
        new_key = normalize_resource_key("https://github.com/o/r/blob/main/llm.md#citations")
        legacy = self._legacy(url, "old")
        current = self.store.create_override(
            kind=KIND, resource_key=new_key, owner="alice", note="", text="new", format="markdown",
            base_url="https://github.com/o/r/blob/main/llm.md#citations", base_hash="h",
        )
        self.store.set_selection(KIND, new_key, "alice", current["id"])
        with patch(_FETCH_EXCERPT, return_value=GUIDE):
            self.assertEqual(migrate_legacy_override_keys(self.store), 1)
        self.assertEqual(self._key(legacy["id"]), new_key)
        self.assertEqual(self.store.get_selection(KIND, new_key, "alice"), current["id"])
        self.assertIsNone(self.store.get_selection(KIND, legacy_resource_key(url), "alice"))


class TestStartLegacyOverrideKeyMigration(unittest.TestCase):
    def test_runs_migration_in_background_thread(self):
        store = object()
        with patch("fastapi_app.lib.doc_rules.legacy_key_migration.migrate_legacy_override_keys", return_value=0) as mock_migrate:
            thread = start_legacy_override_key_migration(lambda: store)  # type: ignore[arg-type, return-value]
            thread.join(timeout=5)
        mock_migrate.assert_called_once_with(store)

    def test_exceptions_are_logged_not_raised(self):
        with patch(
            "fastapi_app.lib.doc_rules.legacy_key_migration.migrate_legacy_override_keys", side_effect=RuntimeError("boom")
        ), self.assertLogs("fastapi_app.lib.doc_rules.legacy_key_migration", level="ERROR"):
            thread = start_legacy_override_key_migration(lambda: object())  # type: ignore[arg-type, return-value]
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
