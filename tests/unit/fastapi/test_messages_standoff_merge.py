"""
Unit tests for the merge of the stand-off lists: contributions of users who cannot edit a file,
and saves over a file that others reviewed or commented in place.

@testCovers fastapi_app/lib/messages/standoff_merge.py
"""

import unittest
from pathlib import Path

from lxml import etree

from fastapi_app.lib.messages.standoff_merge import apply_contribution, merge_foreign_standoff, review_annotation
from fastapi_app.lib.messages.standoff_reader import (
    COMMENT_LIST_TYPE,
    REVIEW_LIST_TYPE,
    find_standoff_list,
    read_comments,
    read_review_data,
    resp_persons,
    thread_status,
)

FIXTURE = Path(__file__).parent.parent / "fixtures" / "standoff" / "messages-sample.tei.xml"

NEW_THREAD = """      <annotation xml:id="uc-new001" motivation="commenting" target="#xpath(/TEI/text/back/listBibl/bibl[3])" resp="#cdoe">
        <revisionDesc>
          <change when="2026-10-24T09:00:00Z" who="#cdoe"/>
        </revisionDesc>
        <note type="fingerprint">abcdef12</note>
        <note type="comment">New thread</note>
      </annotation>
"""

CDOE_REVIEW = """      <annotation xml:id="ur-cdoe" motivation="assessing" target="#xpath(//text)" resp="#cdoe">
        <revisionDesc><change when="2026-10-24T09:00:00Z"/></revisionDesc>
        <note type="not-ok" n="1f14d510">Wrong author</note>
      </annotation>
"""

CDOE_RESP = """        <respStmt>
          <persName xml:id="cdoe">Cy Doe</persName>
          <resp>Reviewer</resp>
        </respStmt>
"""


def comments_of(xml: str) -> dict[str, str]:
    root = etree.fromstring(xml.encode("utf-8"))
    return {c.id: c.text for c in read_comments(find_standoff_list(root, COMMENT_LIST_TYPE))}


def reviewers_of(xml: str) -> dict[str, dict[str, str]]:
    root = etree.fromstring(xml.encode("utf-8"))
    data = read_review_data(find_standoff_list(root, REVIEW_LIST_TYPE))
    return {r.id: {fp: m.state for fp, m in r.marks.items()} for r in data.reviewers.values()}


def outside_standoff(xml: str) -> str:
    return xml[: xml.index("<standOff>")] + xml[xml.index("</standOff>"):]


class TestApplyContribution(unittest.TestCase):
    def setUp(self) -> None:
        self.xml = FIXTURE.read_text(encoding="utf-8")

    def editor_text(self) -> str:
        """The text of cdoe's editor: a new thread, a review, a respStmt, and edits cdoe may not make."""
        xml = self.xml.replace("</titleStmt>", CDOE_RESP.lstrip(" ") + "      </titleStmt>", 1)
        xml = xml.replace('      <annotation xml:id="uc-ccc331"', NEW_THREAD + '      <annotation xml:id="uc-ccc331"', 1)
        xml = xml.replace('      <annotation xml:id="ur-llm-openai-gpt"', CDOE_REVIEW + '      <annotation xml:id="ur-llm-openai-gpt"', 1)
        xml = xml.replace("units=5 ok=1 not-ok=2", "units=5 ok=0 not-ok=3")
        xml = xml.replace("Doe 2020</bibl>", "Changed</bibl>")  # text: ignored
        xml = xml.replace("Agreed.", "Changed by cdoe")  # bkim's reply: ignored
        return xml

    def test_takes_only_the_users_own_annotations(self) -> None:
        stored = self.xml
        result = apply_contribution(stored, self.editor_text(), "cdoe", "Cy Doe", reviews=True, comments=True)
        self.assertEqual(comments_of(result)["uc-new001"], "New thread")
        self.assertEqual(comments_of(result)["uc-aaa113"], "Agreed.")
        self.assertEqual(reviewers_of(result)["cdoe"], {"1f14d510": "not-ok"})
        self.assertIn("units=5 ok=0 not-ok=3", result)
        self.assertNotIn("Changed</bibl>", result)
        self.assertEqual(resp_persons(etree.fromstring(result.encode("utf-8")))["cdoe"], "Cy Doe")
        # outside the standOff only the respStmt was added
        self.assertEqual(outside_standoff(result).replace(CDOE_RESP, ""), outside_standoff(stored))

    def test_respects_the_users_roles(self) -> None:
        result = apply_contribution(self.xml, self.editor_text(), "cdoe", "Cy Doe", reviews=False, comments=True)
        self.assertIn("uc-new001", comments_of(result))
        self.assertNotIn("cdoe", reviewers_of(result))
        self.assertIn("units=5 ok=1 not-ok=2", result)
        # an annotator commenting gets the resp of their editor's respStmt
        result = apply_contribution(self.xml, self.editor_text(), "cdoe", "Cy Doe", reviews=True, comments=False)
        self.assertNotIn("uc-new001", comments_of(result))
        self.assertIn("cdoe", reviewers_of(result))

    def test_edits_deletions_and_status_changes(self) -> None:
        # jdoe edits their thread, deletes their reply and reopens... resolves asmith's thread
        incoming = self.xml.replace("Check the &lt;title&gt;, @asmith.", "Edited by jdoe")
        start = incoming.index('      <annotation xml:id="uc-aaa112"')
        end = incoming.index("</annotation>\n", start) + len("</annotation>\n")
        incoming = incoming[:start] + incoming[end:]
        incoming = incoming.replace(
            '<change when="2026-10-23T09:00:00Z" who="#asmith"/>',
            '<change when="2026-10-23T09:00:00Z" who="#asmith"/>\n          <change when="2026-10-24T08:00:00Z" who="#jdoe" status="resolved"/>',
        )
        result = apply_contribution(self.xml, incoming, "jdoe", "Jane Doe", reviews=False, comments=True)
        comments = comments_of(result)
        self.assertEqual(comments["uc-bbb221"], "Edited by jdoe")
        self.assertNotIn("uc-aaa112", comments)
        root = next(c for c in read_comments(find_standoff_list(etree.fromstring(result.encode("utf-8")), COMMENT_LIST_TYPE)) if c.id == "uc-aaa111")
        self.assertEqual(thread_status(root), "resolved")
        self.assertIn("uc-ccc331", comments)  # an orphan the merge did not cause stays

    def test_deleting_own_thread_deletes_its_replies(self) -> None:
        start = self.xml.index('      <annotation xml:id="uc-aaa111"')
        end = self.xml.index('      <annotation xml:id="uc-aaa112"')
        incoming = self.xml[:start] + self.xml[end:]
        result = apply_contribution(self.xml, incoming, "asmith", "Anna Smith", reviews=True, comments=True)
        self.assertFalse({"uc-aaa111", "uc-aaa112", "uc-aaa113"} & set(comments_of(result)))

    def test_creates_the_lists_and_standoff(self) -> None:
        stored = self.xml[: self.xml.index("  <standOff>")] + self.xml[self.xml.index("</standOff>\n") + len("</standOff>\n"):]
        result = apply_contribution(stored, self.editor_text(), "cdoe", "Cy Doe", reviews=True, comments=True)
        self.assertEqual(set(comments_of(result)), {"uc-new001"})
        self.assertEqual(set(reviewers_of(result)), {"cdoe"})
        self.assertIn('<note type="unit-xpath">./back/listBibl/*</note>', result)

    def test_nothing_to_contribute(self) -> None:
        self.assertEqual(apply_contribution(self.xml, self.xml, "cdoe", "Cy Doe", reviews=True, comments=True), self.xml)


class TestReviewAnnotation(unittest.TestCase):
    def test_returns_the_users_review_annotation(self) -> None:
        xml = FIXTURE.read_text(encoding="utf-8")
        xml = xml.replace('      <annotation xml:id="ur-llm-openai-gpt"', CDOE_REVIEW + '      <annotation xml:id="ur-llm-openai-gpt"', 1)
        self.assertEqual(review_annotation(xml, "cdoe"), CDOE_REVIEW.strip())
        self.assertIsNone(review_annotation(xml, "nobody"))


class TestMergeForeignStandoff(unittest.TestCase):
    def setUp(self) -> None:
        self.xml = FIXTURE.read_text(encoding="utf-8")

    def test_newer_review_of_another_user_wins(self) -> None:
        stored = self.xml.replace(
            '<revisionDesc><change when="2026-10-20T10:00:00Z"/></revisionDesc>\n        <note type="ok">1f14d510</note>',
            '<revisionDesc><change when="2026-10-24T10:00:00Z"/></revisionDesc>\n        <note type="not-ok" n="1f14d510">Changed my mind</note>',
        )
        # the owner's editor still has asmith's old marks, and an edit of the text
        incoming = self.xml.replace("Doe 2020</bibl>", "Doe 2021</bibl>")
        merged = merge_foreign_standoff(stored, incoming, "jdoe")
        self.assertEqual(reviewers_of(merged)["asmith"]["1f14d510"], "not-ok")
        self.assertIn("Doe 2021</bibl>", merged)

    def test_saver_changes_to_others_review_stay_when_not_older(self) -> None:
        # the owner's editor turned a mark into "before the last edit" without changing the reviewer's time
        incoming = self.xml.replace('<note type="ok">1f14d510</note>', '<note type="was-ok">1f14d510</note>')
        merged = merge_foreign_standoff(self.xml, incoming, "jdoe")
        self.assertIn('<note type="was-ok">1f14d510</note>', merged)

    def test_review_added_meanwhile_is_kept_and_llm_follows_the_saver(self) -> None:
        stored = self.xml.replace('      <annotation xml:id="ur-llm-openai-gpt"', CDOE_REVIEW + '      <annotation xml:id="ur-llm-openai-gpt"', 1)
        stored = stored.replace("</titleStmt>", CDOE_RESP.lstrip(" ") + "      </titleStmt>", 1)
        start = self.xml.index('      <annotation xml:id="ur-llm-openai-gpt"')
        end = self.xml.index("</annotation>\n", start) + len("</annotation>\n")
        incoming = self.xml[:start] + self.xml[end:]  # the saver removed the LLM review
        merged = merge_foreign_standoff(stored, incoming, "jdoe")
        self.assertEqual(set(reviewers_of(merged)), {"asmith", "bkim", "cdoe"})
        self.assertEqual(resp_persons(etree.fromstring(merged.encode("utf-8")))["cdoe"], "Cy Doe")

    def test_resolve_by_another_user_on_savers_thread_is_kept(self) -> None:
        stored = self.xml.replace(
            '<change when="2026-10-23T12:00:00Z" who="#asmith" status="resolved"/>',
            '<change when="2026-10-23T12:00:00Z" who="#asmith" status="resolved"/>\n          <change when="2026-10-24T12:00:00Z" who="#bkim" status="open"/>',
        )
        incoming = self.xml.replace("Check the &lt;title&gt;, @asmith.", "Edited by jdoe")
        merged = merge_foreign_standoff(stored, incoming, "jdoe")
        root = next(c for c in read_comments(find_standoff_list(etree.fromstring(merged.encode("utf-8")), COMMENT_LIST_TYPE)) if c.id == "uc-bbb221")
        self.assertEqual(thread_status(root), "open")
        self.assertEqual(root.text, "Edited by jdoe")

    def test_comment_deleted_meanwhile_by_its_author_goes(self) -> None:
        start = self.xml.index('      <annotation xml:id="uc-aaa113"')
        end = self.xml.index("</annotation>\n", start) + len("</annotation>\n")
        stored = self.xml[:start] + self.xml[end:]
        merged = merge_foreign_standoff(stored, self.xml, "jdoe")
        self.assertNotIn("uc-aaa113", comments_of(merged))
        self.assertIn("uc-aaa112", comments_of(merged))


if __name__ == "__main__":
    unittest.main()
