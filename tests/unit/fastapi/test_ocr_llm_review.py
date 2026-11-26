"""
Unit tests for the LLM review of OCR errors in segmentation TEI documents (#931 Part A).

@testCovers fastapi_app/lib/ocr/llm_review.py
"""

import asyncio
import json
import unittest
from unittest.mock import patch

from fastapi_app.lib.llm.base import LLMProvider
from fastapi_app.lib.ocr.llm_review import (
    FIRST_WORD_NOTE,
    LineCorrection,
    MissingLayoutError,
    OcrReviewSource,
    build_system_prompt,
    build_user_prompt,
    findings_from_corrections,
    parse_corrections,
    prepare_source,
    review_window,
)
from fastapi_app.lib.tei.layout import LineLayout, register_layout_provider, unregister_layout_provider
from fastapi_app.lib.tei.zone_lines import ZoneLabel, read_zone_document

VARIANT = "test.ocr-llm-review"
LABELS = [ZoneLabel("front", "front"), ZoneLabel("body", "body"), ZoneLabel("note:footnote", "note", (("place", "footnote"),))]
FOOTNOTE_ZONE = '<note place="footnote">12) Vgl. die Begründung, S. 120.<lb/>13) Vgl. ebd.<lb/>?!?) Vgl. Dnncker&amp;Humblot, Berlin.<lb/></note>'
SECOND_BODY = "<body>Seite zwie<!--x--> beginnt hier mit Text.<lb/>Weitere Zeile</body>"
XML = (
    '<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><profileDesc><langUsage><language ident="de"/></langUsage></profileDesc></teiHeader>'
    '<text xml:lang="de"><front>Titel der Abhandlung<lb/></front>'
    "<body>Die Gesellschaft haftet nach der neuen Regel’). Weitere Ausführungen folgen.<lb/>"
    "wie es das Gesetz jetzt ausdrücklich vorsieht.<lb/>"
    "der Vorstand und der Aufsichtsrat<lb/></body>"
    f"{FOOTNOTE_ZONE}{SECOND_BODY}"
    '<note place="footnote">15) Fußnote.<lb/></note></text></TEI>'
)
# lines 0-6 on page 1, lines 7-8 on page 2
PAGES = [0] * 7 + [1] * 2


class FakeProvider:
    """Returns queued responses and records the user prompts."""

    def __init__(self, responses: list[str]) -> None:
        self.responses = list(responses)
        self.user_prompts: list[str] = []

    async def chat_completion(self, model_id: str, system_prompt: str, user_prompt: str, temperature: float = 0.2) -> str:
        self.user_prompts.append(user_prompt)
        return self.responses.pop(0)


def answer(*items: tuple[str, str, str]) -> str:
    return json.dumps([{"line": line, "old": old, "new": new, "rationale": "OCR"} for line, old, new in items])


def line_texts(xml: str) -> list[str]:
    return [line.text for line in read_zone_document(xml, LABELS).lines]


class OcrReviewTestCase(unittest.TestCase):
    def setUp(self) -> None:
        register_layout_provider(VARIANT, "test", lambda xml, doc_id: LineLayout(pages=PAGES))
        self.labels_patch = patch("fastapi_app.lib.ocr.llm_review.get_zone_labels", return_value=LABELS)
        self.labels_patch.start()
        self.source = prepare_source(XML, "doc1", VARIANT)
        self.window = self.source.windows[0]

    def tearDown(self) -> None:
        self.labels_patch.stop()
        unregister_layout_provider(VARIANT)

    def parse(self, raw: str) -> tuple[list[LineCorrection], list[str]]:
        with self.assertLogs("fastapi_app.lib.ocr.llm_review", level="INFO"):
            return parse_corrections(raw, self.source, self.window, 0.5)


class TestPrepareAndPrompts(OcrReviewTestCase):
    def test_source_has_page_windows_and_languages(self):
        self.assertIsInstance(self.source, OcrReviewSource)
        self.assertEqual([[p.number for p in w] for w in self.source.windows], [[1, 2]])
        self.assertEqual(self.source.languages, ["de"])

    def test_prompt_contains_numbered_lines_and_rules(self):
        system = build_system_prompt()
        self.assertIn("Correct only OCR misreadings", system)
        self.assertIn("Check that footnote numbers are consecutive", system)
        self.assertIn("When unsure, don't suggest.", system)
        self.assertIn("`rn`/`m`", system)
        self.assertIn('[{"line": "0412", "old": "…", "new": "…", "rationale": "…"}]', system)
        user = build_user_prompt(self.source, self.window, (1, 1))
        self.assertIn("0002 | Die Gesellschaft haftet nach der neuen Regel’).", user)
        self.assertIn("0007 | ?!?) Vgl. Dnncker&Humblot, Berlin.", user)
        self.assertNotIn("&amp;", user)
        self.assertIn("de", user)

    def test_context_lines_are_marked(self):
        doc = self.source.doc
        pages = self.source.windows[0]
        window = [pages[0]]
        user = build_user_prompt(self.source, window, (1, 2))
        before, _, after = user.partition("0007 | ?!?)")
        self.assertIn("Context", after)
        self.assertIn("0008 | Seite zwie beginnt", after)
        self.assertEqual(len(doc.lines), 9)
        user2 = build_user_prompt(self.source, [pages[1]], (2, 2))
        context, _, _ = user2.partition("0008 | Seite")
        self.assertIn("Context", context)
        self.assertIn("0007 | ?!?)", context)

    def test_missing_layout(self):
        with self.assertRaises(MissingLayoutError):
            prepare_source(XML, "doc1", "test.no-layout")

    def test_not_a_zone_document(self):
        with patch("fastapi_app.lib.ocr.llm_review.get_zone_labels", return_value=None):
            with self.assertRaises(ValueError):
                prepare_source(XML, "doc1", VARIANT)

    def test_scope_selects_its_pages(self):
        source = prepare_source(XML, "doc1", VARIANT, scope=FOOTNOTE_ZONE)
        self.assertEqual([[p.number for p in w] for w in source.windows], [[1]])
        source = prepare_source(XML, "doc1", VARIANT, scope=SECOND_BODY)
        self.assertEqual([[p.number for p in w] for w in source.windows], [[2]])
        with self.assertRaises(ValueError):
            prepare_source(XML, "doc1", VARIANT, scope="<teiHeader>")

    def test_scope_occurring_more_than_once_is_refused(self):
        with self.assertRaisesRegex(ValueError, "occurs more than once"):
            prepare_source(XML, "doc1", VARIANT, scope="<lb/>")


class TestParse(OcrReviewTestCase):
    def test_parse_keeps_marker_fix(self):
        kept, dropped = self.parse(answer(("0002", "Regel’).", "Regel12).")))
        self.assertEqual(kept, [LineCorrection(1, "Regel’).", "Regel12).", "OCR")])
        self.assertEqual(dropped, [])

    def test_parse_drops_old_not_in_line(self):
        kept, dropped = self.parse(answer(("0002", "Regel’) .", "Regel12).")))
        self.assertEqual(kept, [])
        self.assertEqual(len(dropped), 1)
        self.assertIn("Regel’) .", dropped[0])

    def test_parse_drops_line_outside_window(self):
        source = prepare_source(XML, "doc1", VARIANT, scope=FOOTNOTE_ZONE)
        with self.assertLogs("fastapi_app.lib.ocr.llm_review", level="INFO"):
            kept, dropped = parse_corrections(answer(("0008", "zwie", "zwei")), source, source.windows[0], 0.5)
        self.assertEqual(kept, [])
        self.assertEqual(len(dropped), 1)

    def test_parse_drops_ambiguous_old(self):
        kept, dropped = self.parse(answer(("0004", "der", "den")))
        self.assertEqual(kept, [])
        self.assertEqual(len(dropped), 1)

    def test_parse_drops_word_count_change(self):
        kept, dropped = self.parse(answer(("0003", "ausdrücklich", "aus drücklich")))
        self.assertEqual(kept, [])
        self.assertEqual(len(dropped), 1)

    def test_parse_drops_rewrite(self):
        kept, dropped = self.parse(answer(("0003", "Gesetz", "Rechtslage")))
        self.assertEqual(kept, [])
        self.assertEqual(len(dropped), 1)

    def test_parse_keeps_garbage_digits(self):
        kept, dropped = self.parse(answer(("0007", "?!?)", "312)")))
        self.assertEqual([c.new for c in kept], ["312)"])
        self.assertEqual(dropped, [])

    def test_parse_ignores_noop(self):
        kept, dropped = self.parse(answer(("0007", "Berlin.", "Berlin.")))
        self.assertEqual((kept, dropped), ([], []))

    def test_parse_ignores_whitespace_only_change(self):
        kept, dropped = self.parse(answer(("0002", "Die Gesellschaft", "Die  Gesellschaft")))
        self.assertEqual((kept, dropped), ([], []))


class TestFindings(OcrReviewTestCase):
    def test_findings_map_to_unique_xml_span(self):
        corrections = [LineCorrection(1, "Regel’).", "Regel12).", "marker"), LineCorrection(5, "Vgl.", "vgl.", "case")]
        findings = findings_from_corrections(self.source, corrections)
        self.assertEqual([f["id"] for f in findings], [0, 1])
        expected = line_texts(XML)
        expected[1] = expected[1].replace("Regel’).", "Regel12).")
        expected[5] = "13) vgl. ebd."
        xml = XML
        for finding in findings:
            self.assertEqual(xml.count(finding["old"]), 1)
            xml = xml.replace(finding["old"], finding["new"])
        self.assertEqual(line_texts(xml), expected)

    def test_entity_is_escaped_in_new(self):
        findings = findings_from_corrections(self.source, [LineCorrection(6, "Dnncker&Humblot,", "Duncker&Humblot,", "OCR")])
        self.assertEqual(len(findings), 1)
        self.assertIn("Dnncker&amp;Humblot,", findings[0]["old"])
        self.assertIn("Duncker&amp;Humblot,", findings[0]["new"])

    def test_crossing_lb_or_tag_is_dropped(self):
        with self.assertLogs("fastapi_app.lib.ocr.llm_review", level="INFO"):
            findings = findings_from_corrections(
                self.source,
                [LineCorrection(7, "zwie beginnt", "zwei beginnt", "comment"), LineCorrection(8, "Zeile 15)", "Zeile 16)", "tag")],
            )
        self.assertEqual(findings, [])

    def test_first_word_correction_notes_sync_check(self):
        findings = findings_from_corrections(
            self.source, [LineCorrection(6, "?!?)", "14)", "marker"), LineCorrection(1, "Regel’).", "Regel12).", "marker")]
        )
        by_new = {f["new"]: f["rationale"] for f in findings}
        self.assertEqual(by_new["14)"], "“?!?)” → “14)”: marker" + FIRST_WORD_NOTE)
        self.assertEqual(by_new["Regel12)."], "“Regel’).” → “Regel12).”: marker")

    def test_rationale_shows_plain_correction(self):
        findings = findings_from_corrections(self.source, [LineCorrection(6, "Dnncker&Humblot,", "Duncker&Humblot,", "")])
        self.assertEqual(findings[0]["rationale"], "“Dnncker&Humblot,” → “Duncker&Humblot,”")

    def test_correction_changing_nothing_is_dropped(self):
        with self.assertLogs("fastapi_app.lib.ocr.llm_review", level="INFO") as logs:
            findings = findings_from_corrections(self.source, [LineCorrection(1, "Die Gesellschaft", "Die  Gesellschaft", "spacing")])
        self.assertEqual(findings, [])
        self.assertIn("changes nothing", logs.output[0])

    def test_widened_finding_keeps_lb(self):
        # "wie" also occurs in "zwie", so the finding is widened by the <lb/> before the line
        findings = findings_from_corrections(self.source, [LineCorrection(2, "wie", "Wie", "case")])
        self.assertEqual(len(findings), 1)
        self.assertTrue(findings[0]["old"].startswith("<lb/>"), findings[0]["old"])
        self.assertTrue(findings[0]["new"].startswith("<lb/>"), findings[0]["new"])
        xml = XML.replace(findings[0]["old"], findings[0]["new"])
        self.assertIn("ausdrücklich vorsieht.<lb/>", xml)
        self.assertIn("Regel’). Weitere Ausführungen folgen.<lb/>Wie es das Gesetz", xml)
        self.assertEqual(xml.count("<lb/>"), XML.count("<lb/>"))
        expected = line_texts(XML)
        expected[2] = expected[2].replace("wie", "Wie", 1)
        self.assertEqual(line_texts(xml), expected)


class TestReviewWindow(OcrReviewTestCase):
    def test_review_window_retries_with_dropped_snippets(self):
        provider = FakeProvider([answer(("0002", "Regel’) .", "Regel12).")), answer(("0002", "Regel’).", "Regel12)."))])
        fake: LLMProvider = provider  # type: ignore[assignment]
        with self.assertLogs("fastapi_app.lib", level="INFO"):
            findings, count, discarded = asyncio.run(review_window(self.source, 0, fake, "m", 0.5))
        self.assertEqual(len(provider.user_prompts), 2)
        self.assertIn("Regel’) .", provider.user_prompts[1])
        self.assertEqual(count, 1)
        self.assertEqual(discarded, 0)
        self.assertEqual([f["new"] for f in findings], ["Regel12)."])


if __name__ == "__main__":
    unittest.main()
