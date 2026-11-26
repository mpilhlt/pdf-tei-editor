"""
Unit tests for the shared LLM JSON list extraction.

@testCovers fastapi_app/lib/llm/json_response.py
"""

import unittest

from fastapi_app.lib.llm.json_response import UnusableResponseError, extract_json_list

LOGGER = "fastapi_app.lib.llm.json_response"


class TestExtractJsonList(unittest.TestCase):
    def test_parses_plain_array(self):
        self.assertEqual(extract_json_list('[{"a": 1}]', "test"), [{"a": 1}])

    def test_strips_markdown_code_fence(self):
        self.assertEqual(extract_json_list('```json\n[{"a": 1}]\n```', "test"), [{"a": 1}])

    def test_extracts_array_surrounded_by_prose(self):
        raw = 'Here are my findings:\n[{"a": 1}]\nHope this helps!'
        self.assertEqual(extract_json_list(raw, "test"), [{"a": 1}])

    def test_bracket_in_prose_does_not_break_extraction(self):
        self.assertEqual(extract_json_list('See [1] below.\n[{"a": 1}]', "test"), [{"a": 1}])

    def test_empty_list_is_a_valid_result(self):
        self.assertEqual(extract_json_list("[]", "test"), [])

    def test_repairs_unescaped_quotes_in_xml_attribute_values(self):
        raw = (
            '[\n {\n "old": "supra note <biblScope unit="issue">3</biblScope>",\n'
            ' "rationale": "The word "supra", like "op. cit.", refers to an earlier work."\n }\n]'
        )
        with self.assertLogs(LOGGER, level="INFO"):
            found = extract_json_list(raw, "test")
        self.assertEqual(found[0]["old"], 'supra note <biblScope unit="issue">3</biblScope>')
        self.assertEqual(found[0]["rationale"], 'The word "supra", like "op. cit.", refers to an earlier work.')

    def test_repairs_invalid_escapes_and_raw_newlines(self):
        raw = '[{"old": "x", "rationale": "it\\\'s a\ntitle \\<x\\>"}]'
        with self.assertLogs(LOGGER, level="INFO"):
            found = extract_json_list(raw, "test")
        self.assertEqual(found[0]["rationale"], "it\\'s a\ntitle \\<x\\>")

    def test_quotes_in_prose_before_the_array_do_not_break_repair(self):
        raw = 'Here is the "list":\n```json\n[{"old": "x", "new": "<title level="a">A</title>"}]\n```'
        with self.assertLogs(LOGGER, level="INFO"):
            found = extract_json_list(raw, "test")
        self.assertEqual(found[0]["new"], '<title level="a">A</title>')

    def test_salvages_complete_objects_of_a_truncated_list(self):
        raw = '```json\n[\n  {"old": "a", "new": "n"},\n  {"old": "b", "new": "n2"},\n  {"old": "<title>A Pa'
        with self.assertLogs(LOGGER, level="WARNING") as logs:
            found = extract_json_list(raw, "test")
        self.assertEqual([f["new"] for f in found], ["n", "n2"])
        self.assertIn("truncated", "\n".join(logs.output))
        self.assertIn("test:", "\n".join(logs.output))

    def test_salvages_truncated_response_with_unescaped_quotes(self):
        raw = '[{"old": "a", "new": "<title level="a">A</title>"},\n {"old": "b", "new": "<persName ref="#p'
        with self.assertLogs(LOGGER, level="WARNING"):
            found = extract_json_list(raw, "test")
        self.assertEqual([f["new"] for f in found], ['<title level="a">A</title>'])

    def test_no_list_raises_and_logs_the_response(self):
        with self.assertLogs(LOGGER, level="WARNING") as logs, self.assertRaises(UnusableResponseError):
            extract_json_list("not json at all", "test")
        self.assertIn("not json at all", "\n".join(logs.output))

    def test_empty_response_raises(self):
        with self.assertLogs(LOGGER, level="WARNING"), self.assertRaises(UnusableResponseError):
            extract_json_list("   ", "test")

    def test_non_list_json_raises(self):
        with self.assertLogs(LOGGER, level="WARNING"), self.assertRaises(UnusableResponseError):
            extract_json_list('{"old": "x"}', "test")

    def test_truncated_without_any_complete_object_raises(self):
        with self.assertLogs(LOGGER, level="WARNING"), self.assertRaises(UnusableResponseError):
            extract_json_list('```json\n[\n  {"old": "<persName>J. Do', "test")
