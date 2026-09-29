"""
Unit tests for the "additional instructions" editorialDecl contribution in
the LLamore extractor.

@testCovers fastapi_app/plugins/llamore_extractor/extractor.py
"""

import unittest
from unittest.mock import patch

from fastapi_app.lib.doc_rules.extraction_contribution import ResolvedFragment
from fastapi_app.plugins.llamore_extractor.extractor import LLamoreExtractor


class TestResolveAdditionalInstructions(unittest.TestCase):
    @patch("fastapi_app.plugins.llamore_extractor.extractor.get_db")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.get_document_rules_store")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.for_extraction")
    def test_resolves_via_for_extraction_and_builds_editorial_decl_entry(
        self, mock_for_extraction, mock_get_store, mock_get_db
    ):
        mock_for_extraction.return_value = [
            ResolvedFragment(
                url_pinned=f"https://github.com/mpilhlt/pdf-tei-editor/blob/{'a' * 40}/fastapi_app/plugins/llamore_extractor/prompts/additional-instructions.md",
                label="Reference extraction instructions",
                text="Do the thing.",
            ),
        ]

        extractor = LLamoreExtractor()
        text, entries = extractor._resolve_additional_instructions("alice")

        self.assertEqual(text, "Do the thing.")
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry["category"], "additional-instructions")
        self.assertEqual(entry["n"], "Reference extraction instructions")
        self.assertEqual(len(entry["refs"]), 1)
        ref = entry["refs"][0]
        self.assertEqual(ref["target"], mock_for_extraction.return_value[0].url_pinned)
        self.assertEqual(ref["subtype"], "human")
        self.assertEqual(ref["content_type"], "markdown")

        mock_for_extraction.assert_called_once()
        call_args = mock_for_extraction.call_args
        self.assertEqual(call_args[0][0], "alice")
        descriptors = call_args[0][1]
        self.assertEqual(len(descriptors), 1)
        self.assertEqual(
            descriptors[0].url,
            "https://github.com/mpilhlt/pdf-tei-editor/blob/main/fastapi_app/plugins/llamore_extractor/prompts/additional-instructions.md",
        )
        self.assertTrue(descriptors[0].file.name == "additional-instructions.md")
        self.assertEqual(descriptors[0].label, "Reference extraction instructions")

    @patch("fastapi_app.plugins.llamore_extractor.extractor.get_db")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.get_document_rules_store")
    @patch("fastapi_app.plugins.llamore_extractor.extractor.for_extraction")
    def test_username_none_is_passed_through_unchanged(self, mock_for_extraction, mock_get_store, mock_get_db):
        mock_for_extraction.return_value = [
            ResolvedFragment(url_pinned="https://example.org/x.md", label="Reference extraction instructions", text="Shipped."),
        ]

        extractor = LLamoreExtractor()
        extractor._resolve_additional_instructions(None)

        call_args = mock_for_extraction.call_args
        self.assertIsNone(call_args[0][0])
