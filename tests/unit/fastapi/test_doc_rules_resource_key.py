"""
Unit tests for resource key normalization and format inference.

@testCovers fastapi_app/lib/doc_rules/resource_key.py
"""

import unittest

from fastapi_app.lib.doc_rules.resource_key import infer_format, normalize_resource_key


class TestNormalizeResourceKey(unittest.TestCase):
    def test_sha_and_branch_github_urls_collide(self):
        sha_url = "https://github.com/mpilhlt/pdf-tei-editor/blob/abc123/rules.md"
        branch_url = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md"
        self.assertEqual(normalize_resource_key(sha_url), normalize_resource_key(branch_url))

    def test_line_range_fragment_is_retained(self):
        url = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md#L10-L20"
        self.assertTrue(normalize_resource_key(url).endswith("#L10-L20"))

    def test_different_line_ranges_produce_different_keys(self):
        base = "https://github.com/mpilhlt/pdf-tei-editor/blob/main/rules.md"
        self.assertNotEqual(
            normalize_resource_key(f"{base}#L1-L5"),
            normalize_resource_key(f"{base}#L6-L10"),
        )

    def test_unrecognized_url_used_verbatim(self):
        url = "https://example.com/schema/tei.rng"
        self.assertEqual(normalize_resource_key(url), url)

    def test_malformed_github_url_falls_back_to_verbatim_instead_of_raising(self):
        # Matches GitHubAdapter.matches() (github.com host, "/blob/" in path)
        # but has no file path after the ref, so GitHubAdapter.strip_ref()'s
        # internal parsing fails - this must degrade to "used verbatim",
        # not raise, since a hand-edited ref/@target can be malformed.
        url = "https://github.com/owner/repo/blob/main"
        self.assertEqual(normalize_resource_key(url), url)


class TestInferFormat(unittest.TestCase):
    def test_markdown_extension(self):
        self.assertEqual(infer_format("https://example.com/a/rules.md"), "markdown")
        self.assertEqual(infer_format("https://example.com/a/rules.markdown"), "markdown")

    def test_xml_and_rng_extensions(self):
        self.assertEqual(infer_format("https://example.com/schema/tei.rng"), "xml")
        self.assertEqual(infer_format("https://example.com/a/data.xml"), "xml")

    def test_default_is_text(self):
        self.assertEqual(infer_format("https://example.com/a/notes"), "text")

    def test_extension_check_ignores_fragment(self):
        self.assertEqual(infer_format("https://example.com/a/rules.md#L1-L5"), "markdown")
