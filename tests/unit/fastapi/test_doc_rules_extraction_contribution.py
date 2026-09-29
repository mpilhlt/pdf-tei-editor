"""
Unit tests for the document rules registry's extraction-time contribution API.

@testCovers fastapi_app/lib/doc_rules/extraction_contribution.py
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.doc_rules.extraction_contribution import ExtractionFragment, for_extraction
from fastapi_app.lib.doc_rules.resource_key import normalize_resource_key
from fastapi_app.lib.doc_rules.storage import DocumentRulesStore

FRAGMENT_URL = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/some/prompt.md"


class TestForExtraction(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db = DatabaseManager(Path(self.temp_dir.name) / "test.db")
        self.store = DocumentRulesStore(self.db)

        self.shipped_file = Path(self.temp_dir.name) / "prompt.md"
        self.shipped_file.write_text("Shipped default text.", encoding="utf-8")

    def tearDown(self):
        self.temp_dir.cleanup()

    def _fragment(self):
        return ExtractionFragment(url=FRAGMENT_URL, file=self.shipped_file, label="Reference extraction instructions")

    @patch("fastapi_app.lib.doc_rules.extraction_contribution.resolve_forge_permalink")
    def test_no_override_returns_shipped_text(self, mock_resolve):
        mock_resolve.return_value = FRAGMENT_URL.replace("main", "c" * 40)

        results = for_extraction("alice", [self._fragment()], self.store)

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].text, "Shipped default text.")
        self.assertEqual(results[0].label, "Reference extraction instructions")
        self.assertEqual(results[0].url_pinned, FRAGMENT_URL.replace("main", "c" * 40))

    @patch("fastapi_app.lib.doc_rules.extraction_contribution.resolve_forge_permalink")
    def test_selected_override_wins_over_shipped_text(self, mock_resolve):
        pinned_url = FRAGMENT_URL.replace("main", "c" * 40)
        mock_resolve.return_value = pinned_url

        override = self.store.create_override(
            kind="interpretation-ref",
            resource_key=normalize_resource_key(pinned_url),
            owner="alice",
            note="",
            text="Alice's override text.",
            format="markdown",
            base_url=pinned_url,
            base_hash="hash",
        )
        self.store.set_selection("interpretation-ref", normalize_resource_key(pinned_url), "alice", override["id"])

        results = for_extraction("alice", [self._fragment()], self.store)

        self.assertEqual(results[0].text, "Alice's override text.")

    @patch("fastapi_app.lib.doc_rules.extraction_contribution.resolve_forge_permalink")
    def test_another_users_override_is_ignored(self, mock_resolve):
        pinned_url = FRAGMENT_URL.replace("main", "c" * 40)
        mock_resolve.return_value = pinned_url

        override = self.store.create_override(
            kind="interpretation-ref",
            resource_key=normalize_resource_key(pinned_url),
            owner="alice",
            note="",
            text="Alice's override text.",
            format="markdown",
            base_url=pinned_url,
            base_hash="hash",
        )
        self.store.set_selection("interpretation-ref", normalize_resource_key(pinned_url), "alice", override["id"])

        results = for_extraction("bob", [self._fragment()], self.store)

        self.assertEqual(results[0].text, "Shipped default text.")

    @patch("fastapi_app.lib.doc_rules.extraction_contribution.resolve_forge_permalink")
    def test_none_user_never_looks_up_an_override(self, mock_resolve):
        mock_resolve.return_value = FRAGMENT_URL.replace("main", "c" * 40)
        self.store.get_selected_override_text = MagicMock(side_effect=AssertionError("should not be called"))

        results = for_extraction(None, [self._fragment()], self.store)

        self.assertEqual(results[0].text, "Shipped default text.")

    @patch("fastapi_app.lib.doc_rules.extraction_contribution.resolve_forge_permalink")
    def test_seeds_the_cache_under_the_pinned_url_with_the_shipped_text(self, mock_resolve):
        pinned_url = FRAGMENT_URL.replace("main", "c" * 40)
        mock_resolve.return_value = pinned_url

        with patch("fastapi_app.lib.doc_rules.extraction_contribution.UrlCache") as MockUrlCache:
            mock_cache = MagicMock()
            MockUrlCache.return_value = mock_cache

            for_extraction("alice", [self._fragment()], self.store)

            mock_cache.set_text.assert_called_once_with(pinned_url, "Shipped default text.")

    @patch("fastapi_app.lib.doc_rules.extraction_contribution.resolve_forge_permalink")
    def test_multiple_descriptors_each_resolved_independently(self, mock_resolve):
        mock_resolve.side_effect = lambda url, cache: url.replace("main", "c" * 40)
        second_file = Path(self.temp_dir.name) / "prompt2.md"
        second_file.write_text("Second shipped text.", encoding="utf-8")

        results = for_extraction("alice", [
            self._fragment(),
            ExtractionFragment(url=FRAGMENT_URL.replace("prompt.md", "prompt2.md"), file=second_file, label="Second"),
        ], self.store)

        self.assertEqual(len(results), 2)
        self.assertEqual(results[0].text, "Shipped default text.")
        self.assertEqual(results[1].text, "Second shipped text.")
        self.assertEqual(results[1].label, "Second")

    @patch("fastapi_app.lib.doc_rules.extraction_contribution.resolve_forge_permalink")
    def test_missing_shipped_file_raises_instead_of_being_swallowed(self, mock_resolve):
        # Deliberate fail-fast: a missing shipped file is a packaging bug in
        # the calling plugin, not user data - see for_extraction()'s docstring.
        mock_resolve.return_value = FRAGMENT_URL.replace("main", "c" * 40)
        missing_fragment = ExtractionFragment(
            url=FRAGMENT_URL,
            file=Path(self.temp_dir.name) / "does-not-exist.md",
            label="Reference extraction instructions",
        )

        with self.assertRaises(FileNotFoundError):
            for_extraction("alice", [missing_fragment], self.store)
