"""
Unit tests for annotation-rules fetching and slicing.

@testCovers fastapi_app/lib/utils/annotation_rules_utils.py
"""

import unittest
from unittest.mock import MagicMock, patch

from fastapi_app.lib.utils.annotation_rules_utils import (
    RuleFetchError,
    _ATX_HEADING_RE,
    _rewrite_relative_markdown_urls,
    _scan_markdown_headings,
    _slugify_heading,
    derelativize_markdown_urls,
    fetch_rule_section,
    heading_anchor_at_line,
    is_heading_anchor_fragment,
    markdown_section_range,
    splice_heading_section,
    extract_annotation_rule_refs,
    fetch_rule_excerpt,
    is_line_range_fragment,
    resolve_forge_permalink,
    splice_line_range,
    translate_anchor_to_line_range,
)

SAMPLE_TEXT = "\n".join(f"line {i}" for i in range(1, 21))  # "line 1" .. "line 20"


class TestResolveForgePermalink(unittest.TestCase):
    def test_returns_url_unchanged_for_unrecognized_host(self):
        cache = MagicMock()
        url = "https://pad.gwdg.de/s/abc123/download"
        self.assertEqual(resolve_forge_permalink(url, cache), url)

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_resolves_github_url(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_response = MagicMock()
        mock_response.json.return_value = {"sha": "c" * 40}
        mock_get.return_value = mock_response

        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#segmentation"
        resolved = resolve_forge_permalink(url, cache)
        self.assertEqual(
            resolved,
            f"https://github.com/mpilhlt/fossil/blob/{'c' * 40}/docs/guidelines.md#segmentation",
        )

    @patch("fastapi_app.lib.core.git_forge_adapters.requests.get")
    def test_falls_back_to_original_url_when_api_call_fails(self, mock_get):
        """
        A forge API failure (network error, rate limit, etc.) must never
        propagate out of resolve_forge_permalink - callers (extraction, the
        "Refresh Annotation Rules" action) must never fail because of it.
        """
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.side_effect = ConnectionError("boom")

        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#segmentation"
        with self.assertLogs("fastapi_app.lib.utils.annotation_rules_utils", level="WARNING"):
            resolved = resolve_forge_permalink(url, cache)
        self.assertEqual(resolved, url)


class TestFetchRuleExcerpt(unittest.TestCase):
    def _mock_response(self, text, content_type="text/plain; charset=utf-8"):
        response = MagicMock()
        response.text = text
        response.headers = {"Content-Type": content_type}
        response.raise_for_status = MagicMock()
        return response

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_returns_whole_text_when_no_fragment(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.return_value = self._mock_response(SAMPLE_TEXT)

        result = fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download", cache)
        self.assertEqual(result, SAMPLE_TEXT)

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_slices_github_style_line_range(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.return_value = self._mock_response(SAMPLE_TEXT)

        result = fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download#L3-L5", cache)
        self.assertEqual(result, "line 3\nline 4\nline 5")

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_slices_gitlab_style_line_range(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.return_value = self._mock_response(SAMPLE_TEXT)

        result = fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download#L3-5", cache)
        self.assertEqual(result, "line 3\nline 4\nline 5")

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_slices_single_line(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.return_value = self._mock_response(SAMPLE_TEXT)

        result = fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download#L7", cache)
        self.assertEqual(result, "line 7")

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_clamps_out_of_range_end(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.return_value = self._mock_response(SAMPLE_TEXT)

        result = fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download#L18-L500", cache)
        self.assertEqual(result, "line 18\nline 19\nline 20")

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_unrecognized_fragment_returns_whole_text(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.return_value = self._mock_response(SAMPLE_TEXT)

        result = fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download#segmentation", cache)
        self.assertEqual(result, SAMPLE_TEXT)

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_raises_on_html_content_type(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.return_value = self._mock_response("<html>not raw text</html>", content_type="text/html")

        with self.assertRaises(RuleFetchError):
            fetch_rule_excerpt("https://example.com/some/page", cache)

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_uses_cache_when_available(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = SAMPLE_TEXT

        result = fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download#L1-L2", cache)

        mock_get.assert_not_called()
        self.assertEqual(result, "line 1\nline 2")

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_converts_github_blob_url_to_raw_before_fetching(self, mock_fetch_get):
        # Only patch annotation_rules_utils.requests.get, not
        # git_forge_adapters.requests.get too: both modules do `import
        # requests` (the whole module), so the two "module-qualified" patch
        # targets actually collide on the same underlying `requests.get`
        # attribute - patching it twice makes the second patch silently
        # clobber the first's mock. GitHubAdapter.to_raw_url() never calls
        # requests anyway (it's pure string manipulation), so one patch is
        # both correct and sufficient here.
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_fetch_get.return_value = self._mock_response(SAMPLE_TEXT)

        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md#L1-L2"
        result = fetch_rule_excerpt(url, cache)

        mock_fetch_get.assert_called_once_with(
            "https://raw.githubusercontent.com/mpilhlt/fossil/main/docs/guidelines.md",
            timeout=30,
            allow_redirects=True,
        )
        self.assertEqual(result, "line 1\nline 2")

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_passes_through_allow_redirects_false(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.return_value = self._mock_response(SAMPLE_TEXT)

        fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download", cache, allow_redirects=False)

        mock_get.assert_called_once_with(
            "https://pad.gwdg.de/s/abc/download",
            timeout=30,
            allow_redirects=False,
        )

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_sha_pinned_github_url_reads_cache_with_ignore_ttl(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = "cached content"

        url = f"https://github.com/mpilhlt/fossil/blob/{'a' * 40}/docs/guidelines.md"
        result = fetch_rule_excerpt(url, cache)

        self.assertEqual(result, "cached content")
        cache.get_text.assert_called_once_with(
            f"https://raw.githubusercontent.com/mpilhlt/fossil/{'a' * 40}/docs/guidelines.md",
            ignore_ttl=True,
        )
        mock_get.assert_not_called()

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_branch_ref_github_url_reads_cache_without_ignore_ttl(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = "cached content"

        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"
        fetch_rule_excerpt(url, cache)

        cache.get_text.assert_called_once_with(
            "https://raw.githubusercontent.com/mpilhlt/fossil/main/docs/guidelines.md",
            ignore_ttl=False,
        )

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_unrecognized_host_reads_cache_without_ignore_ttl(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = "cached content"

        fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download", cache)

        cache.get_text.assert_called_once_with("https://pad.gwdg.de/s/abc/download", ignore_ttl=False)

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_rewrites_relative_image_and_link_targets_for_markdown_resource(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        mock_get.return_value = self._mock_response(
            'See ![diagram](img/diagram.png) and [the guide](../other.md).'
        )

        url = "https://github.com/mpilhlt/fossil/blob/main/docs/guidelines.md"
        result = fetch_rule_excerpt(url, cache)

        self.assertEqual(
            result,
            'See ![diagram](https://raw.githubusercontent.com/mpilhlt/fossil/main/docs/img/diagram.png) '
            'and [the guide](https://raw.githubusercontent.com/mpilhlt/fossil/main/other.md).',
        )

    @patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get")
    def test_does_not_rewrite_links_for_non_markdown_resource(self, mock_get):
        cache = MagicMock()
        cache.get_text.return_value = None
        text = 'See ![diagram](img/diagram.png)'
        mock_get.return_value = self._mock_response(text)

        result = fetch_rule_excerpt("https://pad.gwdg.de/s/abc/download", cache)

        self.assertEqual(result, text)


class TestRewriteRelativeMarkdownUrls(unittest.TestCase):
    BASE = "https://raw.githubusercontent.com/mpilhlt/fossil/main/docs/"

    def test_rewrites_relative_image_target(self):
        result = _rewrite_relative_markdown_urls("![alt](img/foo.png)", self.BASE)
        self.assertEqual(result, f"![alt]({self.BASE}img/foo.png)")

    def test_leaves_absolute_url_unchanged(self):
        text = "[link](https://example.com/foo.png)"
        self.assertEqual(_rewrite_relative_markdown_urls(text, self.BASE), text)

    def test_leaves_pure_anchor_unchanged(self):
        text = "[section](#intro)"
        self.assertEqual(_rewrite_relative_markdown_urls(text, self.BASE), text)

    def test_leaves_protocol_relative_url_unchanged(self):
        text = "[link](//example.com/foo.png)"
        self.assertEqual(_rewrite_relative_markdown_urls(text, self.BASE), text)

    def test_resolves_parent_relative_path_against_base(self):
        result = _rewrite_relative_markdown_urls("[link](../other.md)", self.BASE)
        self.assertEqual(result, "[link](https://raw.githubusercontent.com/mpilhlt/fossil/main/other.md)")


class TestDerelativizeMarkdownUrls(unittest.TestCase):
    """
    Inverse of TestRewriteRelativeMarkdownUrls above - round-trips its
    "resolves_parent_relative_path_against_base" case back to the original
    relative form, since that's exactly what a resource's original_text has
    already been through once (see fetch_rule_excerpt()) before a user's
    override text reaches derelativize_markdown_urls() on its way to being
    proposed as the file's new upstream content.
    """

    BASE_URL = "https://github.com/mpilhlt/fossil/blob/main/docs/guide.md"

    def test_rewrites_same_repo_sibling_link_back_to_relative(self):
        text = "![alt](https://raw.githubusercontent.com/mpilhlt/fossil/main/docs/img/foo.png)"
        self.assertEqual(derelativize_markdown_urls(text, self.BASE_URL), "![alt](img/foo.png)")

    def test_rewrites_same_repo_link_at_different_ref_back_to_relative(self):
        # The link is pinned to a commit SHA (this app's own resolution at
        # fetch time) while BASE_URL is on "main" - still the same repo, so
        # it must still round-trip; the ref is deliberately irrelevant here.
        text = f"[link](https://raw.githubusercontent.com/mpilhlt/fossil/{'a' * 40}/docs/other.md)"
        self.assertEqual(derelativize_markdown_urls(text, self.BASE_URL), "[link](other.md)")

    def test_resolves_parent_directory_link_back_to_relative(self):
        text = "[link](https://raw.githubusercontent.com/mpilhlt/fossil/main/other.md)"
        self.assertEqual(derelativize_markdown_urls(text, self.BASE_URL), "[link](../other.md)")

    def test_leaves_different_repo_url_unchanged(self):
        text = "[link](https://raw.githubusercontent.com/other-org/other-repo/main/docs/x.md)"
        self.assertEqual(derelativize_markdown_urls(text, self.BASE_URL), text)

    def test_leaves_non_forge_absolute_url_unchanged(self):
        text = "[link](https://example.com/docs/x.md)"
        self.assertEqual(derelativize_markdown_urls(text, self.BASE_URL), text)

    def test_leaves_already_relative_link_unchanged(self):
        text = "[link](./other.md)"
        self.assertEqual(derelativize_markdown_urls(text, self.BASE_URL), text)

    def test_returns_text_unchanged_for_non_markdown_base_url(self):
        text = "[link](https://raw.githubusercontent.com/mpilhlt/fossil/main/docs/img/foo.png)"
        xml_base_url = "https://github.com/mpilhlt/fossil/blob/main/schema/tei.rng"
        self.assertEqual(derelativize_markdown_urls(text, xml_base_url), text)

    def test_returns_text_unchanged_when_base_url_is_not_a_recognized_forge(self):
        text = "[link](https://raw.githubusercontent.com/mpilhlt/fossil/main/docs/img/foo.png)"
        self.assertEqual(derelativize_markdown_urls(text, "https://pad.gwdg.de/s/abc/notes.md"), text)


class TestSpliceLineRange(unittest.TestCase):
    """splice_line_range() is fetch_rule_excerpt()'s line-range slicing in reverse."""

    def _lines(self, text: str) -> list[str]:
        return text.splitlines()

    def test_replaces_exactly_the_inclusive_range(self):
        result = self._lines(splice_line_range(SAMPLE_TEXT, "L5-L7", "A\nB"))
        self.assertEqual(result[:4], ["line 1", "line 2", "line 3", "line 4"])
        self.assertEqual(result[4:6], ["A", "B"])
        self.assertEqual(result[6], "line 8")
        self.assertEqual(len(result), 19)

    def test_range_starting_at_first_line(self):
        result = self._lines(splice_line_range(SAMPLE_TEXT, "L1-L2", "X"))
        self.assertEqual(result[:2], ["X", "line 3"])
        self.assertEqual(len(result), 19)

    def test_range_ending_at_last_line(self):
        result = self._lines(splice_line_range(SAMPLE_TEXT, "L19-L20", "X"))
        self.assertEqual(result[-2:], ["line 18", "X"])
        self.assertEqual(len(result), 19)

    def test_single_line_fragment(self):
        result = self._lines(splice_line_range(SAMPLE_TEXT, "L3", "X"))
        self.assertEqual(result[1:4], ["line 2", "X", "line 4"])
        self.assertEqual(len(result), 20)

    def test_gitlab_style_fragment(self):
        result = self._lines(splice_line_range(SAMPLE_TEXT, "L3-4", "X"))
        self.assertEqual(result[1:4], ["line 2", "X", "line 5"])

    def test_end_beyond_file_is_clamped(self):
        result = self._lines(splice_line_range(SAMPLE_TEXT, "L19-L99", "X"))
        self.assertEqual(result[-2:], ["line 18", "X"])

    def test_unchanged_excerpt_round_trips(self):
        full = SAMPLE_TEXT + "\n"
        with patch("fastapi_app.lib.utils.annotation_rules_utils.requests.get") as mock_get:
            mock_get.return_value = MagicMock(text=full, headers={"Content-Type": "text/plain"})
            cache = MagicMock()
            cache.get_text.return_value = None
            for fragment in ("L1-L1", "L1-L20", "L5-L7", "L20-L20", "L3"):
                excerpt = fetch_rule_excerpt(f"https://example.com/rules.txt#{fragment}", cache)
                self.assertEqual(splice_line_range(full, fragment, excerpt), full, fragment)

    def test_preserves_trailing_newline(self):
        self.assertEqual(splice_line_range("a\nb\nc\n", "L2", "X"), "a\nX\nc\n")
        self.assertEqual(splice_line_range("a\nb\nc", "L2", "X"), "a\nX\nc")

    def test_non_line_range_fragment_returns_excerpt_as_whole_file(self):
        self.assertEqual(splice_line_range(SAMPLE_TEXT, "intro", "X"), "X")
        self.assertEqual(splice_line_range(SAMPLE_TEXT, "", "X"), "X")


class TestIsLineRangeFragment(unittest.TestCase):
    def test_recognizes_github_style_range(self):
        self.assertTrue(is_line_range_fragment("L10-L50"))

    def test_recognizes_gitlab_style_range(self):
        self.assertTrue(is_line_range_fragment("L10-50"))

    def test_recognizes_single_line(self):
        self.assertTrue(is_line_range_fragment("L7"))

    def test_rejects_heading_anchor(self):
        self.assertFalse(is_line_range_fragment("document-segmentation-model"))


SAMPLE_DOC = """# Document Segmentation Model

Some intro text about segmentation.

## Details

More details here.

# Citation Model

Citation content.
"""

DUPLICATE_HEADINGS_DOC = """# Notes

First.

# Notes

Second.
"""


class TestTranslateAnchorToLineRange(unittest.TestCase):
    @patch("fastapi_app.lib.utils.annotation_rules_utils.fetch_rule_excerpt")
    def test_top_level_section_spans_to_next_same_level_heading(self, mock_fetch):
        mock_fetch.return_value = SAMPLE_DOC
        cache = MagicMock()
        result = translate_anchor_to_line_range("https://example.com/g.md", "document-segmentation-model", cache)
        self.assertEqual(result, (1, 8))

    @patch("fastapi_app.lib.utils.annotation_rules_utils.fetch_rule_excerpt")
    def test_subsection_bounded_by_next_shallower_heading_not_its_own_children(self, mock_fetch):
        mock_fetch.return_value = SAMPLE_DOC
        cache = MagicMock()
        result = translate_anchor_to_line_range("https://example.com/g.md", "details", cache)
        self.assertEqual(result, (5, 8))

    @patch("fastapi_app.lib.utils.annotation_rules_utils.fetch_rule_excerpt")
    def test_last_section_spans_to_end_of_file(self, mock_fetch):
        mock_fetch.return_value = SAMPLE_DOC
        cache = MagicMock()
        result = translate_anchor_to_line_range("https://example.com/g.md", "citation-model", cache)
        self.assertEqual(result, (9, 11))

    @patch("fastapi_app.lib.utils.annotation_rules_utils.fetch_rule_excerpt")
    def test_deduplicates_repeated_heading_slugs_like_github(self, mock_fetch):
        mock_fetch.return_value = DUPLICATE_HEADINGS_DOC
        cache = MagicMock()
        self.assertEqual(translate_anchor_to_line_range("https://example.com/g.md", "notes", cache), (1, 4))
        self.assertEqual(translate_anchor_to_line_range("https://example.com/g.md", "notes-1", cache), (5, 7))

    @patch("fastapi_app.lib.utils.annotation_rules_utils.fetch_rule_excerpt")
    def test_returns_none_when_anchor_not_found(self, mock_fetch):
        mock_fetch.return_value = SAMPLE_DOC
        cache = MagicMock()
        with self.assertLogs("fastapi_app.lib.utils.annotation_rules_utils", level="WARNING"):
            result = translate_anchor_to_line_range("https://example.com/g.md", "does-not-exist", cache)
        self.assertIsNone(result)

    @patch("fastapi_app.lib.utils.annotation_rules_utils.fetch_rule_excerpt")
    def test_returns_none_when_fetch_fails(self, mock_fetch):
        mock_fetch.side_effect = RuleFetchError("boom")
        cache = MagicMock()
        with self.assertLogs("fastapi_app.lib.utils.annotation_rules_utils", level="WARNING"):
            result = translate_anchor_to_line_range("https://example.com/g.md", "document-segmentation-model", cache)
        self.assertIsNone(result)


class TestScanMarkdownHeadingsEdgeCases(unittest.TestCase):
    def test_title_ending_in_literal_hash_without_preceding_space_not_truncated(self):
        match = _ATX_HEADING_RE.match("# C#")
        self.assertIsNotNone(match)
        self.assertEqual(match.group(2), "C#")

        headings = _scan_markdown_headings("# C#\n")
        self.assertEqual(len(headings), 1)
        self.assertEqual(headings[0]["level"], 1)

    def test_hash_prefixed_line_inside_fenced_code_block_is_not_a_heading(self):
        doc = """# Real Heading

Some text.

```
# fake heading
```

# Another Real Heading

More text.
"""
        headings = _scan_markdown_headings(doc)
        slugs = [h["slug"] for h in headings]
        self.assertEqual(slugs, ["real-heading", "another-real-heading"])

    def test_two_consecutive_spaces_in_title_produce_two_consecutive_hyphens(self):
        self.assertEqual(_slugify_heading("Foo  Bar"), "foo--bar")

    def test_seven_hashes_does_not_match_as_heading(self):
        headings = _scan_markdown_headings("####### Not A Heading\n")
        self.assertEqual(headings, [])

    def test_no_space_after_hash_does_not_match_as_heading(self):
        headings = _scan_markdown_headings("#NotAHeading\n")
        self.assertEqual(headings, [])


class TestExtractAnnotationRuleRefs(unittest.TestCase):
    def test_extracts_human_and_machine_refs_for_one_interpretation(self):
        xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p>
            <ref subtype="human" target="https://example.com/guidelines.md#segmentation" type="markdown"/>
            <ref subtype="machine" target="https://example.com/guidelines.md#L1-L20" type="markdown"/>
          </p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        refs = extract_annotation_rule_refs(xml)
        self.assertEqual(refs, [
            {
                "category": "primary",
                "refs": [
                    {"target": "https://example.com/guidelines.md#segmentation", "content_type": "markdown", "subtype": "human"},
                    {"target": "https://example.com/guidelines.md#L1-L20", "content_type": "markdown", "subtype": "machine"},
                ],
            },
        ])

    def test_extracts_multiple_interpretations(self):
        xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref subtype="human" target="https://example.com/guidelines.md#segmentation" type="markdown"/></p>
        </interpretation>
        <interpretation type="footnote-annotation">
          <p><ref subtype="machine" target="https://example.com/guidelines.md#L120-L180" type="markdown"/></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        refs = extract_annotation_rule_refs(xml)
        self.assertEqual(len(refs), 2)
        self.assertEqual(refs[0]["category"], "primary")
        self.assertEqual(refs[1]["category"], "footnote-annotation")

    def test_returns_empty_list_when_no_editorial_decl(self):
        xml = '<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/></TEI>'
        self.assertEqual(extract_annotation_rule_refs(xml), [])

    def test_returns_empty_list_for_malformed_xml(self):
        self.assertEqual(extract_annotation_rule_refs("<not><valid"), [])

    def test_skips_interpretation_missing_type_attribute(self):
        xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation>
          <p><ref subtype="human" target="https://example.com/g.md" type="markdown"/></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        self.assertEqual(extract_annotation_rule_refs(xml), [])

    def test_skips_interpretation_whose_only_ref_is_missing_target(self):
        xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref subtype="human" type="markdown"/></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        self.assertEqual(extract_annotation_rule_refs(xml), [])

    def test_skips_ref_with_unrecognized_subtype_but_keeps_others(self):
        xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p>
            <ref subtype="robot" target="https://example.com/g.md#odd" type="markdown"/>
            <ref subtype="human" target="https://example.com/g.md#seg" type="markdown"/>
          </p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        refs = extract_annotation_rule_refs(xml)
        self.assertEqual(len(refs), 1)
        self.assertEqual(len(refs[0]["refs"]), 1)
        self.assertEqual(refs[0]["refs"][0]["subtype"], "human")

    def test_skips_interpretation_whose_only_ref_has_missing_subtype(self):
        xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref target="https://example.com/g.md" type="markdown"/></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        self.assertEqual(extract_annotation_rule_refs(xml), [])

    def test_content_type_is_none_when_ref_type_absent(self):
        xml = """<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <encodingDesc>
      <editorialDecl>
        <interpretation type="primary">
          <p><ref subtype="human" target="https://example.com/g.md"/></p>
        </interpretation>
      </editorialDecl>
    </encodingDesc>
  </teiHeader>
</TEI>
"""
        refs = extract_annotation_rule_refs(xml)
        self.assertEqual(len(refs), 1)
        self.assertIsNone(refs[0]["refs"][0]["content_type"])


class TestExtractAnnotationRuleRefsLabel(unittest.TestCase):
    def test_includes_n_when_present(self):
        xml = """<?xml version="1.0"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
          <teiHeader><encodingDesc><editorialDecl>
            <interpretation type="data-correction" n="Data correction">
              <p><ref target="https://example.com/rules.md" subtype="human"/></p>
            </interpretation>
          </editorialDecl></encodingDesc></teiHeader>
        </TEI>"""
        entries = extract_annotation_rule_refs(xml)
        self.assertEqual(entries[0].get("n"), "Data correction")

    def test_omits_n_key_entirely_when_absent(self):
        xml = """<?xml version="1.0"?>
        <TEI xmlns="http://www.tei-c.org/ns/1.0">
          <teiHeader><encodingDesc><editorialDecl>
            <interpretation type="primary">
              <p><ref target="https://example.com/rules.md" subtype="human"/></p>
            </interpretation>
          </editorialDecl></encodingDesc></teiHeader>
        </TEI>"""
        entries = extract_annotation_rule_refs(xml)
        self.assertNotIn("n", entries[0])


class TestMarkdownSections(unittest.TestCase):
    TEXT = "# T\n\n## A\na1\n### A.1\na2\n## B\nb1\n"
    URL = "https://raw.githubusercontent.com/mpilhlt/fossil/main/docs/g.md"

    def test_section_range(self):
        self.assertEqual(markdown_section_range(self.TEXT, "a"), (3, 6))
        self.assertEqual(markdown_section_range(self.TEXT, "b"), (7, 8))
        self.assertIsNone(markdown_section_range(self.TEXT, "missing"))

    def test_section_range_ignores_fenced_heading(self):
        text = "## B\n```\n## A\n```\n"
        self.assertIsNone(markdown_section_range(text, "a"))

    def test_heading_anchor_at_line(self):
        self.assertEqual(heading_anchor_at_line(self.TEXT, 3), "a")
        self.assertIsNone(heading_anchor_at_line(self.TEXT, 4))

    def test_is_heading_anchor_fragment(self):
        self.assertTrue(is_heading_anchor_fragment("a"))
        self.assertFalse(is_heading_anchor_fragment("L3-L6"))
        self.assertFalse(is_heading_anchor_fragment(""))

    def test_splice_heading_section(self):
        self.assertEqual(
            splice_heading_section(self.TEXT, "a", "## A\nnew"),
            "# T\n\n## A\nnew\n## B\nb1\n",
        )
        unchanged = "\n".join(self.TEXT.splitlines()[2:6])
        self.assertEqual(splice_heading_section(self.TEXT, "a", unchanged), self.TEXT)
        with self.assertRaises(RuleFetchError):
            splice_heading_section(self.TEXT, "missing", "x")

    def test_fetch_rule_section(self):
        import tempfile
        from pathlib import Path
        from fastapi_app.lib.core.url_cache import UrlCache
        with tempfile.TemporaryDirectory() as d:
            cache = UrlCache(Path(d))
            cache.set_text(self.URL, self.TEXT)
            self.assertEqual(fetch_rule_section(f"{self.URL}#a", cache), "## A\na1\n### A.1\na2")
            self.assertEqual(fetch_rule_section(f"{self.URL}#L7-L8", cache), "## B\nb1")
            with self.assertRaises(RuleFetchError):
                fetch_rule_section(f"{self.URL}#missing", cache)
