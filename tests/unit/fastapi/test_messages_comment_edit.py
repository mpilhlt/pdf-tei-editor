"""
Unit tests for the server-side edits of unit comments: replies and merge on save.

@testCovers fastapi_app/lib/messages/comment_edit.py
"""

import unittest
from pathlib import Path

from lxml import etree

from fastapi_app.lib.messages.comment_edit import ThreadNotFoundError, add_reply, merge_foreign_comments
from fastapi_app.lib.messages.standoff_reader import (
    COMMENT_LIST_TYPE,
    build_threads,
    find_standoff_list,
    read_comments,
    resp_persons,
)

FIXTURE = Path(__file__).parent.parent / "fixtures" / "standoff" / "messages-sample.tei.xml"


def threads_of(xml: str) -> dict[str, tuple[list[str], str]]:
    root = etree.fromstring(xml.encode("utf-8"))
    return {
        t.root.id: ([r.id for r in t.replies], t.status)
        for t in build_threads(read_comments(find_standoff_list(root, COMMENT_LIST_TYPE)))
    }


def outside_standoff_and_header(xml: str) -> str:
    """The text after the standOff (must stay byte for byte)."""
    return xml[xml.index("</standOff>"):]


class TestAddReply(unittest.TestCase):
    def setUp(self) -> None:
        self.xml = FIXTURE.read_text(encoding="utf-8")

    def test_reply_goes_after_the_last_reply(self) -> None:
        result = add_reply(self.xml, "uc-aaa111", "bkim", "Bo Kim", "One more <thing> & more", when="2026-10-24T10:00:00Z")
        replies, status = threads_of(result.xml)["uc-aaa111"]
        self.assertEqual(replies, ["uc-aaa112", "uc-aaa113", result.comment_id])
        self.assertEqual(status, "open")
        self.assertIn("One more &lt;thing&gt; &amp; more", result.annotation_xml)
        self.assertEqual(outside_standoff_and_header(result.xml), outside_standoff_and_header(self.xml))
        # indentation follows the list
        self.assertIn(f'\n      <annotation xml:id="{result.comment_id}"', result.xml)

    def test_reply_reopens_a_resolved_thread(self) -> None:
        result = add_reply(self.xml, "uc-bbb221", "bkim", "Bo Kim", "Not done yet", when="2026-10-24T10:00:00Z")
        self.assertEqual(threads_of(result.xml)["uc-bbb221"], ([result.comment_id], "open"))

    def test_adds_resp_stmt_for_new_commenter(self) -> None:
        result = add_reply(self.xml, "uc-aaa111", "newuser", "New User", "Hello")
        root = etree.fromstring(result.xml.encode("utf-8"))
        self.assertEqual(resp_persons(root)["newuser"], "New User")
        unchanged = add_reply(self.xml, "uc-aaa111", "jdoe", "Jane Doe", "Hello")
        self.assertEqual(unchanged.xml.count('xml:id="jdoe"'), 1)

    def test_unknown_thread(self) -> None:
        with self.assertRaises(ThreadNotFoundError):
            add_reply(self.xml, "uc-nope", "bkim", "Bo Kim", "x")
        with self.assertRaises(ThreadNotFoundError):
            add_reply(self.xml, "uc-aaa112", "bkim", "Bo Kim", "replies to a reply are not threads")


class TestMergeForeignComments(unittest.TestCase):
    def setUp(self) -> None:
        self.xml = FIXTURE.read_text(encoding="utf-8")

    def test_puts_back_a_reply_of_another_user(self) -> None:
        stored = add_reply(self.xml, "uc-aaa111", "bkim", "Bo Kim", "Arrived while editing").xml
        incoming = self.xml.replace("Sample", "Sample (edited)")
        merged = merge_foreign_comments(stored, incoming, "owner")
        replies, _ = threads_of(merged)["uc-aaa111"]
        self.assertEqual(len(replies), 3)
        self.assertIn("Sample (edited)", merged)
        etree.fromstring(merged.encode("utf-8"))

    def test_own_deletions_stay_deleted(self) -> None:
        # jdoe deletes their own reply and their own thread (with asmith's... none) in the incoming text
        start = self.xml.index('<annotation xml:id="uc-aaa112"')
        end = self.xml.index("</annotation>", start) + len("</annotation>")
        incoming = self.xml[:start] + self.xml[end:]
        self.assertEqual(merge_foreign_comments(self.xml, incoming, "jdoe"), incoming)
        # the same deletion by somebody else is undone
        merged = merge_foreign_comments(self.xml, incoming, "owner")
        self.assertIn("uc-aaa112", threads_of(merged)["uc-aaa111"][0])

    def test_restores_the_resp_stmt_of_a_new_commenter(self) -> None:
        stored = add_reply(self.xml, "uc-aaa111", "newuser", "New User", "Hi").xml
        # the editor merged the reply live, but its header has no respStmt for the new user
        start = stored.index("<respStmt>\n          <persName xml:id=\"newuser\"")
        end = stored.index("</respStmt>", start) + len("</respStmt>")
        incoming = stored[:start] + stored[end:]
        merged = merge_foreign_comments(stored, incoming, "owner")
        self.assertEqual(resp_persons(etree.fromstring(merged.encode("utf-8")))["newuser"], "New User")

    def test_restores_the_list_when_the_incoming_text_has_none(self) -> None:
        start = self.xml.index('<listAnnotation type="unit-comment"')
        end = self.xml.index("</listAnnotation>", start) + len("</listAnnotation>")
        incoming = self.xml[:start] + self.xml[end:]
        merged = merge_foreign_comments(self.xml, incoming, "nobody")
        self.assertEqual(set(threads_of(merged)), {"uc-aaa111", "uc-bbb221"})


if __name__ == "__main__":
    unittest.main()
