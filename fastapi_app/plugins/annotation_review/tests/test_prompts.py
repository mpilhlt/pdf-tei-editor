"""
Unit tests for prompt building and response validation.

@testCovers fastapi_app/plugins/annotation_review/prompts.py
"""

import json
import unittest

from fastapi_app.plugins.annotation_review.prompts import (
    UnusableResponseError,
    build_retry_note,
    build_system_prompt,
    build_user_prompt,
    parse_and_validate_findings,
    validate_findings,
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

    def test_asks_for_minimal_non_overlapping_snippets(self):
        prompt = build_system_prompt()
        self.assertIn("SMALLEST", prompt)
        self.assertIn("non-overlapping", prompt)


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

    def test_unparseable_response_raises_with_the_response_text_logged(self):
        with (
            self.assertLogs("fastapi_app.plugins.annotation_review.prompts", level="WARNING") as logs,
            self.assertRaises(UnusableResponseError),
        ):
            parse_and_validate_findings("not json at all", self.SOURCE)
        self.assertIn("not json at all", "\n".join(logs.output))

    def test_empty_response_raises(self):
        with self.assertRaises(UnusableResponseError):
            parse_and_validate_findings("   ", self.SOURCE)

    def test_non_list_json_raises(self):
        with self.assertRaises(UnusableResponseError):
            parse_and_validate_findings('{"old": "x"}', self.SOURCE)

    def test_salvages_complete_findings_from_a_truncated_response(self):
        raw = (
            '```json\n[\n  {"old": "<persName>J. Doe</persName>", "new": "n", "rationale": "r"},\n'
            '  {"old": "<title>A Paper</title>", "new": "n2", "rationale": "r2"},\n'
            '  {"old": "<title>A Pa'
        )
        with self.assertLogs("fastapi_app.plugins.annotation_review.prompts", level="WARNING") as logs:
            findings = parse_and_validate_findings(raw, self.SOURCE)
        self.assertEqual([f["new"] for f in findings], ["n", "n2"])
        self.assertIn("truncated", "\n".join(logs.output))

    def test_truncated_response_without_any_complete_finding_raises(self):
        with self.assertRaises(UnusableResponseError):
            parse_and_validate_findings('```json\n[\n  {"old": "<persName>J. Do', self.SOURCE)

    def test_empty_list_is_a_valid_result(self):
        self.assertEqual(parse_and_validate_findings("[]", self.SOURCE), [])

    def test_extracts_array_surrounded_by_prose(self):
        raw = 'Here are my findings:\n[{"old": "<title>A Paper</title>", "new": "n", "rationale": "r"}]\nHope this helps!'
        self.assertEqual(len(parse_and_validate_findings(raw, self.SOURCE)), 1)

    def test_extracts_fenced_array_followed_by_prose(self):
        raw = '```json\n[{"old": "<title>A Paper</title>", "new": "n", "rationale": "r"}]\n```\nLet me know if you need more.'
        self.assertEqual(len(parse_and_validate_findings(raw, self.SOURCE)), 1)

    def test_bracket_in_prose_does_not_break_extraction(self):
        raw = 'See [1] below.\n[{"old": "<title>A Paper</title>", "new": "n", "rationale": "r"}]'
        self.assertEqual(len(parse_and_validate_findings(raw, self.SOURCE)), 1)

    def test_ids_are_sequential_over_kept_findings_only(self):
        raw = (
            '[{"old": "<persName>J. Doe</persName>", "new": "a", "rationale": "r1"}, '
            '{"old": "<date>NOPE</date>", "new": "b", "rationale": "r2"}, '
            '{"old": "<title>A Paper</title>", "new": "c", "rationale": "r3"}]'
        )
        findings = parse_and_validate_findings(raw, self.SOURCE)
        self.assertEqual([f["id"] for f in findings], [0, 1])
        self.assertEqual(findings[1]["old"], "<title>A Paper</title>")


class TestRedundantWrapFindings(unittest.TestCase):
    SOURCE = (
        "<text><bibl><author>Wilkinson, Mark D.</author>, <author>Myles Axton</author>, "
        "Arie Baak, et al.</bibl></text>"
    )

    def _findings(self, old: str, new: str) -> list[dict[str, object]]:
        raw = json.dumps([{"old": old, "new": new, "rationale": "Every author must be enclosed in <author>."}])
        return [dict(f) for f in parse_and_validate_findings(raw, self.SOURCE)]

    def test_drops_finding_that_wraps_an_authors_content_in_another_author(self):
        self.assertEqual(self._findings("Myles Axton", "<author>Myles Axton</author>"), [])

    def test_drops_finding_that_wraps_a_whole_author_in_another_author(self):
        self.assertEqual(
            self._findings("<author>Myles Axton</author>", "<author><author>Myles Axton</author></author>"), []
        )

    def test_keeps_finding_that_wraps_an_unannotated_author(self):
        findings = self._findings("Arie Baak", "<author>Arie Baak</author>")
        self.assertEqual(len(findings), 1)

    def test_keeps_finding_when_the_source_is_not_well_formed(self):
        raw = json.dumps([{"old": "Axton", "new": "<author>Axton</author>", "rationale": "r"}])
        findings = parse_and_validate_findings(raw, "<author>Myles Axton</author> <bibl>")
        self.assertEqual(len(findings), 1)


class TestValidateFindingsUnmatched(unittest.TestCase):
    SOURCE = "<p><persName>J. Doe</persName> and <persName>J. Doe</persName> met <title>X</title></p>"

    def test_returns_the_old_snippets_that_do_not_occur_exactly_once(self):
        raw = json.dumps([
            {"old": "<title>X</title>", "new": "y", "rationale": "r"},
            {"old": "<persName>J. Doe</persName>", "new": "y", "rationale": "ambiguous"},
            {"old": "<title> X </title>", "new": "y", "rationale": "reformatted"},
            {"old": 1, "new": "y", "rationale": "wrong type, not counted"},
        ])
        kept, unmatched = validate_findings(raw, self.SOURCE)
        self.assertEqual([f["old"] for f in kept], ["<title>X</title>"])
        self.assertEqual(unmatched, ["<persName>J. Doe</persName>", "<title> X </title>"])

    def test_scoped_findings_are_matched_in_the_scope_and_widened_until_unique_in_the_document(self):
        scope = "<bibl><author>A. B</author>, <title>T</title> (<date>2020</date>), <ptr>http://x.de/202 0</ptr></bibl>"
        document = (
            "<listBibl>" + scope
            + "<bibl><author>A. B</author>, <title>T</title> (<date>2020</date>), <ptr>http://x.de/2020</ptr></bibl>"
            + "</listBibl>"
        )
        raw = json.dumps([
            {"old": "<author>A. B</author>", "new": "<author>A.</author> <author>B</author>", "rationale": "shared"},
            {"old": "<title>T</title> (<date>2020</date>), <ptr>http://x.de/202", "new": "<title level=\"m\">T</title>", "rationale": "shared"},
            {"old": "<ptr>http://x.de/2020</ptr>", "new": "x", "rationale": "only outside the scope"},
            {"old": "<ptr>http://x.de/202 0</ptr>", "new": "<ptr>http://x.de/2020</ptr>", "rationale": "unique"},
        ])
        kept, unmatched = validate_findings(raw, document, scope)
        self.assertEqual(unmatched, ["<ptr>http://x.de/2020</ptr>"])
        self.assertEqual(len(kept), 3)
        for finding in kept:
            self.assertEqual(document.count(finding["old"]), 1)
            self.assertIn(finding["old"], scope)
        # Widening to the left cannot help (both occurrences follow "<bibl>"), so it widens to the right
        self.assertEqual(kept[0]["old"], "<author>A. B</author>, <title>T</title> (<date>2020</date>), <ptr>http://x.de/202 ")
        self.assertEqual(kept[0]["new"], "<author>A.</author> <author>B</author>, <title>T</title> (<date>2020</date>), <ptr>http://x.de/202 ")
        self.assertEqual(kept[1]["old"], "<title>T</title> (<date>2020</date>), <ptr>http://x.de/202 ")
        self.assertEqual(kept[1]["new"], "<title level=\"m\">T</title> ")
        self.assertEqual(kept[2]["old"], "<ptr>http://x.de/202 0</ptr>")

    def test_scoped_finding_is_dropped_when_the_scope_itself_is_not_unique(self):
        scope = "<bibl>X</bibl>"
        raw = json.dumps([{"old": "X", "new": "Y", "rationale": "r"}])
        kept, unmatched = validate_findings(raw, scope + scope, scope)
        self.assertEqual(kept, [])
        self.assertEqual(unmatched, ["X"])

    def test_retry_note_quotes_every_unmatched_snippet(self):
        note = build_retry_note(['<title a="1">X</title>', "two"])
        self.assertIn(json.dumps('<title a="1">X</title>'), note)
        self.assertIn('"two"', note)


if __name__ == "__main__":
    unittest.main()
