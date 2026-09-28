"""
Unit tests for fastapi_app/plugins/grobid/annotation_rules.py.

Run manually:
    uv run python tests/unit-test-runner.py fastapi_app/plugins/grobid/tests/test_annotation_rules.py -v

@testCovers fastapi_app/plugins/grobid/annotation_rules.py
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent))

from fastapi_app.plugins.grobid.annotation_rules import build_editorial_decl_entries


class TestBuildEditorialDeclEntriesVariantMatching(unittest.TestCase):
    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_matches_variant_listed_explicitly(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["grobid.training.segmentation"], "category": "primary",
             "type": "markdown", "url": "https://github.com/x/y/blob/main/g.md", "label": "Guide"},
        ]
        mock_resolve.side_effect = lambda url, cache: url

        entries = build_editorial_decl_entries("grobid.training.segmentation", MagicMock())
        guide_entries = [e for e in entries if e["category"] == "primary"]
        self.assertEqual(len(guide_entries), 1)

    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_wildcard_matches_any_variant(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["*"], "category": "house-style",
             "type": "markdown", "url": "https://github.com/x/y/blob/main/g.md", "label": "Guide"},
        ]
        mock_resolve.side_effect = lambda url, cache: url

        entries = build_editorial_decl_entries("grobid.training.header", MagicMock())
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["category"], "house-style")

    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_returns_empty_list_for_unconfigured_variant(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["grobid.training.segmentation"], "category": "primary",
             "type": "markdown", "url": "https://github.com/x/y/blob/main/g.md", "label": "Guide"},
        ]
        entries = build_editorial_decl_entries("grobid.training.header", MagicMock())
        self.assertEqual(entries, [])
        mock_resolve.assert_not_called()


class TestBuildRefsForGuideShapeTable(unittest.TestCase):
    """
    Exercises the four ref-generation shapes documented in
    annotation_rules.py's _build_refs_for_guide(): no fragment, an
    already-machine line-range fragment, a heading-anchor with type "html",
    and a heading-anchor with type "markdown" (which additionally attempts
    translation to a machine ref).
    """

    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_no_fragment_produces_human_only(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["v1"], "category": "primary", "type": "markdown",
             "url": "https://github.com/x/y/blob/main/g.md", "label": "Guide"},
        ]
        mock_resolve.side_effect = lambda url, cache: url.replace("main", "sha1")

        entries = build_editorial_decl_entries("v1", MagicMock())
        self.assertEqual(entries, [
            {"category": "primary", "refs": [
                {"target": "https://github.com/x/y/blob/sha1/g.md", "content_type": "markdown", "subtype": "human"},
            ], "n": "Guide"},
        ])

    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_line_range_fragment_produces_machine_only(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["v1"], "category": "footnote-annotation", "type": "markdown",
             "url": "https://github.com/x/y/blob/main/g.md#L10-L50", "label": "Guide"},
        ]
        mock_resolve.side_effect = lambda url, cache: url.replace("main", "sha1")

        entries = build_editorial_decl_entries("v1", MagicMock())
        self.assertEqual(entries, [
            {"category": "footnote-annotation", "refs": [
                {"target": "https://github.com/x/y/blob/sha1/g.md#L10-L50", "content_type": "markdown", "subtype": "machine"},
            ], "n": "Guide"},
        ])

    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_heading_anchor_with_html_type_produces_human_only(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["v1"], "category": "primary", "type": "html",
             "url": "https://example.com/docs/g.html#section", "label": "Guide"},
        ]
        mock_resolve.side_effect = lambda url, cache: url

        entries = build_editorial_decl_entries("v1", MagicMock())
        self.assertEqual(entries, [
            {"category": "primary", "refs": [
                {"target": "https://example.com/docs/g.html#section", "content_type": "html", "subtype": "human"},
            ], "n": "Guide"},
        ])

    @patch("fastapi_app.plugins.grobid.annotation_rules.translate_anchor_to_line_range")
    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_heading_anchor_with_markdown_type_produces_both_refs(
        self, mock_get_guides, mock_resolve, mock_translate
    ):
        mock_get_guides.return_value = [
            {"variant_ids": ["v1"], "category": "primary", "type": "markdown",
             "url": "https://github.com/x/y/blob/main/g.md#segmentation", "label": "Guide"},
        ]
        mock_resolve.side_effect = lambda url, cache: url.replace("main", "sha1")
        mock_translate.return_value = (10, 40)

        entries = build_editorial_decl_entries("v1", MagicMock())

        self.assertEqual(entries, [
            {"category": "primary", "refs": [
                {"target": "https://github.com/x/y/blob/sha1/g.md#segmentation", "content_type": "markdown", "subtype": "human"},
                {"target": "https://github.com/x/y/blob/sha1/g.md#L10-L40", "content_type": "markdown", "subtype": "machine"},
            ], "n": "Guide"},
        ])
        mock_translate.assert_called_once()
        call_args = mock_translate.call_args[0]
        self.assertEqual(call_args[0], "https://github.com/x/y/blob/sha1/g.md")
        self.assertEqual(call_args[1], "segmentation")

    @patch("fastapi_app.plugins.grobid.annotation_rules.translate_anchor_to_line_range")
    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_heading_anchor_with_markdown_type_falls_back_to_human_only_when_anchor_not_found(
        self, mock_get_guides, mock_resolve, mock_translate
    ):
        mock_get_guides.return_value = [
            {"variant_ids": ["v1"], "category": "primary", "type": "markdown",
             "url": "https://github.com/x/y/blob/main/g.md#segmentation", "label": "Guide"},
        ]
        mock_resolve.side_effect = lambda url, cache: url.replace("main", "sha1")
        mock_translate.return_value = None

        entries = build_editorial_decl_entries("v1", MagicMock())

        self.assertEqual(entries, [
            {"category": "primary", "refs": [
                {"target": "https://github.com/x/y/blob/sha1/g.md#segmentation", "content_type": "markdown", "subtype": "human"},
            ], "n": "Guide"},
        ])


class TestBuildEditorialDeclEntriesSchemaFragment(unittest.TestCase):
    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_appends_schema_fragment_entry_for_a_fragment_variant(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = []
        mock_resolve.side_effect = lambda url, cache: url.replace("main", "sha1")

        entries = build_editorial_decl_entries("grobid.training.segmentation", MagicMock())

        self.assertEqual(entries, [
            {
                "category": "schema-fragment",
                "n": "Segmentation schema source",
                "refs": [{
                    "target": "https://github.com/mpilhlt/fossil/blob/sha1/schema/grobid.training.segmentation.rng",
                    "content_type": "xml",
                    "subtype": "human",
                }],
            },
        ])

    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_no_schema_fragment_entry_for_a_variant_without_a_fossil_source_file(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = []
        mock_resolve.side_effect = lambda url, cache: url

        entries = build_editorial_decl_entries("grobid.training.header", MagicMock())

        self.assertEqual(entries, [])

    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_schema_fragment_entry_appended_alongside_guide_entries(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["grobid.training.segmentation"], "category": "primary", "type": "markdown",
             "url": "https://github.com/x/y/blob/main/g.md", "label": "Document segmentation guidelines"},
        ]
        mock_resolve.side_effect = lambda url, cache: url.replace("main", "sha1")

        entries = build_editorial_decl_entries("grobid.training.segmentation", MagicMock())

        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]["category"], "primary")
        self.assertEqual(entries[1]["category"], "schema-fragment")


class TestBuildEditorialDeclEntriesLabel(unittest.TestCase):
    @patch("fastapi_app.plugins.grobid.annotation_rules.resolve_forge_permalink")
    @patch("fastapi_app.plugins.grobid.annotation_rules.get_annotation_guides")
    def test_guide_label_becomes_entry_n(self, mock_get_guides, mock_resolve):
        mock_get_guides.return_value = [
            {"variant_ids": ["v1"], "category": "primary", "type": "markdown",
             "url": "https://github.com/x/y/blob/main/g.md", "label": "Citation model guidelines"},
        ]
        mock_resolve.side_effect = lambda url, cache: url

        entries = build_editorial_decl_entries("v1", MagicMock())

        self.assertEqual(entries[0]["n"], "Citation model guidelines")


if __name__ == "__main__":
    unittest.main()
