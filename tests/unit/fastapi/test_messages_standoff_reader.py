"""
Unit tests for the server-side reading of stand-off lists and mentions, against the fixtures
shared with the JS unit test `tests/unit/js/standoff-shared-fixtures.test.js`.

@testCovers fastapi_app/lib/messages/standoff_reader.py
@testCovers fastapi_app/lib/messages/mentions.py
"""

import json
import unittest
from dataclasses import asdict
from pathlib import Path

from lxml import etree

from fastapi_app.lib.messages.mentions import find_mentions, mentionable_ids
from fastapi_app.lib.messages.standoff_reader import (
    COMMENT_LIST_TYPE,
    REVIEW_LIST_TYPE,
    build_threads,
    canonical_form,
    element_by_path,
    element_excerpt,
    find_standoff_list,
    find_units,
    fingerprint_of,
    parse_unit_path,
    read_comments,
    read_review_data,
    resp_persons,
)

FIXTURES = Path(__file__).parent.parent / "fixtures" / "standoff"


def load_root() -> etree._Element:  # type: ignore[name-defined]
    return etree.fromstring((FIXTURES / "messages-sample.tei.xml").read_bytes())


class TestSharedFixtures(unittest.TestCase):
    """Compares the Python reading with the digest the JS modules produce."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.expected = json.loads((FIXTURES / "messages-sample.expected.json").read_text())
        cls.root = load_root()

    def test_units_auto(self) -> None:
        fps = [u.fingerprint for u in find_units(self.root, None)]
        self.assertEqual(fps, self.expected["units_auto"]["fingerprints"])

    def test_units_explicit(self) -> None:
        path = self.expected["units_explicit"]["path"]
        fps = [u.fingerprint for u in find_units(self.root, path)]
        self.assertEqual(fps, self.expected["units_explicit"]["fingerprints"])

    def test_review_data(self) -> None:
        data = read_review_data(find_standoff_list(self.root, REVIEW_LIST_TYPE))
        self.assertEqual(data.unit_path, self.expected["review"]["unitPath"])
        actual = [
            {
                "id": r.id, "name": r.name, "isLlm": r.is_llm, "when": r.when,
                "marks": {fp: asdict(m) for fp, m in sorted(r.marks.items())},
                "was": {fp: asdict(m) for fp, m in sorted(r.was.items())},
            }
            for r in sorted(data.reviewers.values(), key=lambda r: r.id)
        ]
        self.assertEqual(actual, self.expected["review"]["reviewers"])

    def test_comments(self) -> None:
        comments = read_comments(find_standoff_list(self.root, COMMENT_LIST_TYPE))
        actual = [
            {
                "id": c.id, "replyTo": c.reply_to, "author": c.author, "text": c.text, "path": c.path,
                "fingerprint": c.fingerprint, "changes": [asdict(ch) for ch in c.changes],
            }
            for c in comments
        ]
        self.assertEqual(actual, self.expected["comments"])
        threads = [
            {"id": t.root.id, "replies": [r.id for r in t.replies], "status": t.status}
            for t in build_threads(comments)
        ]
        self.assertEqual(threads, self.expected["threads"])

    def test_mentions(self) -> None:
        for sample, ids in self.expected["mentions"]:
            self.assertEqual(find_mentions(sample), ids, sample)


class TestStandoffReader(unittest.TestCase):
    def test_resp_persons(self) -> None:
        self.assertEqual(resp_persons(load_root()), {"jdoe": "Jane Doe", "asmith": "Anna Smith", "bkim": "Bo Kim"})

    def test_element_by_path_and_excerpt(self) -> None:
        root = load_root()
        element = element_by_path(root, "/TEI/text/back/listBibl/bibl[2]")
        assert element is not None
        self.assertEqual(element_excerpt(element), "Ibid., p. 12.")
        self.assertIsNone(element_by_path(root, "/TEI/text/back/listBibl/bibl[9]"))
        self.assertIsNone(element_by_path(root, "/TEI/nothing"))

    def test_excerpt_is_shortened(self) -> None:
        element = etree.fromstring("<p>" + "word " * 50 + "</p>")
        excerpt = element_excerpt(element, 20)
        self.assertLessEqual(len(excerpt), 20)
        self.assertTrue(excerpt.endswith("…"))

    def test_canonical_form_ignores_layout(self) -> None:
        a = etree.fromstring('<bibl b="2"  a="1">x <!-- c --> y<hi>z</hi>  </bibl>')
        b = etree.fromstring('<bibl a="1" b="2">x  y<hi> z </hi></bibl>')
        self.assertEqual(canonical_form(a), '<bibl a="1" b="2">x y<hi>z</hi></bibl>')
        self.assertEqual(fingerprint_of(canonical_form(a)), fingerprint_of(canonical_form(b)))

    def test_parse_unit_path(self) -> None:
        self.assertIsNone(parse_unit_path("auto"))
        steps = parse_unit_path(".//listBibl/bibl")
        assert steps is not None
        self.assertEqual([(s.descendant, s.name) for s in steps], [(True, "listBibl"), (False, "bibl")])
        with self.assertRaises(ValueError):
            parse_unit_path("./a[1]")

    def test_mentionable_ids(self) -> None:
        self.assertEqual(mentionable_ids({"jdoe", "grobid"}, "owner", {"jdoe", "owner", "other"}), {"jdoe", "owner"})
        self.assertEqual(find_mentions("@jdoe and @grobid", {"jdoe"}), ["jdoe"])


if __name__ == "__main__":
    unittest.main()
