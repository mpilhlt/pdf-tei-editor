"""
Unit tests for prompt building and response validation.

@testCovers fastapi_app/plugins/annotation_review/prompts.py
"""

import unittest

from fastapi_app.plugins.annotation_review.prompts import (
    build_system_prompt,
    build_user_prompt,
    parse_and_validate_findings,
)


class TestBuildSystemPrompt(unittest.TestCase):
    def test_mentions_json_array_and_keys(self):
        prompt = build_system_prompt()
        self.assertIn("old", prompt)
        self.assertIn("new", prompt)
        self.assertIn("rationale", prompt)
        self.assertIn("JSON", prompt)

    def test_mentions_uniqueness_requirement(self):
        prompt = build_system_prompt()
        self.assertIn("exactly once", prompt)


class TestBuildUserPrompt(unittest.TestCase):
    def test_includes_each_category_and_excerpt(self):
        prompt = build_user_prompt(
            rule_excerpts=[("primary", "Rule A text"), ("footnote-annotation", "Rule B text")],
            text_content="<text><body>hello</body></text>",
        )
        self.assertIn("primary", prompt)
        self.assertIn("Rule A text", prompt)
        self.assertIn("footnote-annotation", prompt)
        self.assertIn("Rule B text", prompt)

    def test_includes_document_text(self):
        prompt = build_user_prompt(
            rule_excerpts=[("primary", "Rule A text")],
            text_content="<text><body>UNIQUE_MARKER_XYZ</body></text>",
        )
        self.assertIn("UNIQUE_MARKER_XYZ", prompt)


class TestParseAndValidateFindings(unittest.TestCase):
    SOURCE = "<body><persName>J. Doe</persName> wrote <title>A Paper</title>.</body>"

    def test_parses_valid_json_array(self):
        raw = (
            '[{"old": "<persName>J. Doe</persName>", '
            '"new": "<persName ref=\\"#p1\\">J. Doe</persName>", '
            '"rationale": "add ref"}]'
        )
        findings = parse_and_validate_findings(raw, self.SOURCE)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["id"], 0)
        self.assertEqual(findings[0]["old"], "<persName>J. Doe</persName>")
        self.assertEqual(findings[0]["rationale"], "add ref")

    def test_strips_markdown_code_fence(self):
        raw = '```json\n[{"old": "<title>A Paper</title>", "new": "<title>A Paper</title>", "rationale": "ok"}]\n```'
        findings = parse_and_validate_findings(raw, self.SOURCE)
        self.assertEqual(len(findings), 1)

    def test_drops_finding_whose_old_is_absent(self):
        raw = '[{"old": "<date>2024</date>", "new": "x", "rationale": "y"}]'
        findings = parse_and_validate_findings(raw, self.SOURCE)
        self.assertEqual(findings, [])

    def test_drops_finding_whose_old_is_ambiguous(self):
        source = "<body>word word</body>"
        raw = '[{"old": "word", "new": "x", "rationale": "y"}]'
        findings = parse_and_validate_findings(raw, source)
        self.assertEqual(findings, [])

    def test_drops_finding_missing_required_key(self):
        raw = '[{"old": "<title>A Paper</title>", "rationale": "y"}]'
        findings = parse_and_validate_findings(raw, self.SOURCE)
        self.assertEqual(findings, [])

    def test_drops_finding_with_non_string_new_or_rationale(self):
        raw = (
            '[{"old": "<persName>J. Doe</persName>", "new": 123, "rationale": "y"}, '
            '{"old": "<title>A Paper</title>", "new": "x", "rationale": null}]'
        )
        findings = parse_and_validate_findings(raw, self.SOURCE)
        self.assertEqual(findings, [])

    def test_malformed_json_returns_empty_list(self):
        findings = parse_and_validate_findings("not json at all", self.SOURCE)
        self.assertEqual(findings, [])

    def test_non_list_json_returns_empty_list(self):
        findings = parse_and_validate_findings('{"old": "x"}', self.SOURCE)
        self.assertEqual(findings, [])

    def test_ids_are_sequential_over_kept_findings_only(self):
        raw = (
            '[{"old": "<persName>J. Doe</persName>", "new": "a", "rationale": "r1"}, '
            '{"old": "<date>NOPE</date>", "new": "b", "rationale": "r2"}, '
            '{"old": "<title>A Paper</title>", "new": "c", "rationale": "r3"}]'
        )
        findings = parse_and_validate_findings(raw, self.SOURCE)
        self.assertEqual([f["id"] for f in findings], [0, 1])
        self.assertEqual(findings[1]["old"], "<title>A Paper</title>")


if __name__ == "__main__":
    unittest.main()
