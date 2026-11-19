"""
Unit tests for the zone-lines module: reading the lines and pieces of a zone document, pages and
their fingerprints, the listing, parsing and checking answers, and applying label changes.

The lines, pieces and page fingerprints of the shared fixture are compared with
`tests/unit/fixtures/zone-lines/segmentation-sample.expected.json`, which the JS mirror's test
(`tests/unit/js/zone-lines.test.js`) compares with its own reading.
Set UPDATE_FIXTURES=1 to rewrite the expected file from the Python result.

@testCovers fastapi_app/lib/tei/zone_lines.py
"""

import json
import os
import unittest
from pathlib import Path

from fastapi_app.lib.tei.zone_lines import (
    OUTSIDE,
    LabelChange,
    ZoneDocument,
    ZoneDocumentError,
    apply_labels,
    changed_pieces,
    changes_between,
    check_changes,
    format_listing,
    insert_page_breaks,
    line_pages_from_page_breaks,
    page_windows,
    pages_of,
    parse_answer,
    parse_line_answer,
    zone_labels,
)

FIXTURES = Path(__file__).parent.parent / "fixtures" / "zone-lines"
SAMPLE = (FIXTURES / "segmentation-sample.tei.xml").read_text(encoding="utf-8")
LAYOUT = json.loads((FIXTURES / "segmentation-sample.layout.json").read_text(encoding="utf-8"))
EXPECTED = FIXTURES / "segmentation-sample.expected.json"
# the sample with the <pb/> elements insert_page_breaks() adds from its layout
SAMPLE_PB = (FIXTURES / "segmentation-sample-pb.tei.xml").read_text(encoding="utf-8")
LABELS = zone_labels(LAYOUT["labels"])
DEMO = Path(__file__).parents[3] / "docker" / "demo-data" / "default" / "tei" / "10.5771__2699-1284-2024-3-149.tei.xml"


def text_of(xml: str) -> str:
    """The <text> of a document."""
    return xml[xml.index("<text"):]


def digest(xml: str) -> dict[str, object]:
    """Lines (pieces) and pages of a document, as compared with the JS reading."""
    doc = ZoneDocument(xml, LABELS)
    return {
        "lines": [
            {"pieces": [[p.label, p.text] for p in line.pieces], "emptyLabel": line.empty_label}
            for line in doc.lines
        ],
        "pages": [
            {"number": p.number, "firstLine": p.first_line, "endLine": p.end_line, "fingerprint": p.fingerprint}
            for p in pages_of(doc, LAYOUT["pages"])
        ],
    }


def non_space(xml: str) -> str:
    doc = ZoneDocument(xml, LABELS)
    return "".join(a.char for a in doc.atoms if a.kind == "char") + f"|{sum(a.kind == 'lb' for a in doc.atoms)}"


class TestReading(unittest.TestCase):
    def test_shared_fixture(self):
        result = digest(SAMPLE)
        if os.environ.get("UPDATE_FIXTURES"):
            EXPECTED.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        self.assertEqual(result, json.loads(EXPECTED.read_text(encoding="utf-8")))

    def test_lines_and_pieces(self):
        doc = ZoneDocument(SAMPLE, LABELS)
        self.assertEqual(len(doc.lines), 18)
        self.assertEqual(doc.lines[1].text, "Cover page & notes")
        self.assertEqual(doc.lines[1].label, "titlePage")
        # a line shared by two zones
        self.assertEqual([(p.label, p.text) for p in doc.lines[10].pieces], [("page", "2"), ("note:headnote", "Doe and Roe, A Sample Article")])
        self.assertIsNone(doc.lines[10].label)
        # a character reference for a no-break space is whitespace
        self.assertEqual(doc.lines[9].text, "1 A footnote with a reference.")
        # text outside zones
        self.assertEqual(doc.lines[15].label, OUTSIDE)

    def test_refuses_other_markup(self):
        xml = SAMPLE.replace("<body>1 Introduction", "<body><hi>1</hi> Introduction")
        with self.assertRaises(ZoneDocumentError):
            ZoneDocument(xml, LABELS)

    def test_unknown_zone_gets_a_code(self):
        xml = SAMPLE.replace('<note place="footnote">', '<note place="margin">').replace("reference. <lb/></note>", "reference. <lb/></note>")
        doc = ZoneDocument(xml, LABELS)
        self.assertEqual(doc.lines[9].label, "note:margin")

    def test_pages(self):
        doc = ZoneDocument(SAMPLE, LABELS)
        pages = pages_of(doc, LAYOUT["pages"])
        self.assertEqual([(p.number, p.first_line, p.end_line) for p in pages], [(1, 0, 2), (2, 2, 10), (3, 10, 16), (4, 16, 18)])
        # lines beyond the layout belong to the last page
        self.assertEqual(pages_of(doc, [0, 0, 1])[-1].end_line, 18)

    def test_fingerprint_changes_with_labels_only_on_its_page(self):
        doc = ZoneDocument(SAMPLE, LABELS)
        before = pages_of(doc, LAYOUT["pages"])
        after = pages_of(doc, LAYOUT["pages"], changed_pieces(doc, [LabelChange(15, 15, label="body")]))
        self.assertNotEqual(before[2].fingerprint, after[2].fingerprint)
        self.assertEqual([p.fingerprint for i, p in enumerate(before) if i != 2], [p.fingerprint for i, p in enumerate(after) if i != 2])

    def test_duplicate_pages(self):
        # lines 16 and 17 (both headnotes after the change) as pages of their own
        doc = ZoneDocument(SAMPLE.replace("<body>Third page. <lb/></body>", '<note place="headnote">Doe and Roe, A Sample Article <lb/></note>'), LABELS)
        pages = pages_of(doc, [0] * 16 + [1, 2])
        self.assertEqual(pages[2].fingerprint, pages[1].fingerprint + ".2")

    def test_demo_document(self):
        doc = ZoneDocument(DEMO.read_text(encoding="utf-8"), LABELS)
        self.assertGreater(len(doc.lines), 200)
        self.assertEqual(doc.lines[0].text, "Urheberrecht")


class TestWindows(unittest.TestCase):
    def test_page_windows(self):
        doc = ZoneDocument(SAMPLE, LABELS)
        pages = pages_of(doc, LAYOUT["pages"])
        self.assertEqual([[p.index for p in w] for w in page_windows(doc, pages, max_pages=2)], [[0, 1], [2, 3]])
        self.assertEqual([[p.index for p in w] for w in page_windows(doc, pages)], [[0, 1, 2, 3]])
        self.assertEqual([[p.index for p in w] for w in page_windows(doc, pages, max_chars=10)], [[0], [1], [2], [3]])
        self.assertEqual([[p.index for p in w] for w in page_windows(doc, pages, max_chars=400)], [[0, 1], [2, 3]])


class TestListingAndAnswers(unittest.TestCase):
    def test_listing(self):
        doc = ZoneDocument(SAMPLE, LABELS)
        pages = pages_of(doc, LAYOUT["pages"])
        hints = [[] for _ in doc.lines]
        hints[10] = ["top", "repeated"]
        listing = format_listing(doc, pages[2:3], hints, context=2)
        self.assertIn("=== Context before (do not change) ===\n0009 body | and goes on.\n0010 note:footnote | 1 A footnote with a reference.", listing)
        self.assertIn("=== Page 3 ===\n0011 {top repeated} | [page]2 [note:headnote]Doe and Roe, A Sample Article", listing)
        self.assertIn("0016 - | stray text outside", listing)
        self.assertIn("=== Context after (do not change) ===\n0017 note:headnote | Doe and Roe, A Sample Article\n0018 body | Third page.", listing)

    def test_parse_answer(self):
        changes = parse_answer(
            "Here are the changes:\n0011-0013 body\n0014 | [listBibl]Smith, J. [body](2020). A book.\nNO CHANGES\n"
            "0016 body {margin} | stray text outside\n"
        )
        self.assertEqual(changes, [
            LabelChange(10, 12, label="body"),
            LabelChange(13, 13, pieces=(("listBibl", "Smith, J."), ("body", "(2020). A book."))),
            LabelChange(15, 15, label="body"),
        ])
        self.assertIsNone(parse_line_answer("0011-0012 | [body]x"))
        self.assertIsNone(parse_line_answer("Page 3"))

    def test_check_changes(self):
        doc = ZoneDocument(SAMPLE, LABELS)
        changes = [
            LabelChange(15, 15, label="body"),  # ok
            LabelChange(15, 15, label="front"),  # overlap
            LabelChange(2, 2, label="body"),  # outside the window
            LabelChange(11, 11, label="nonsense"),  # unknown label
            LabelChange(13, 13, pieces=(("listBibl", "Smith, J."), ("body", "(2021). A book."))),  # text changed
            LabelChange(12, 12, label="body"),  # no-op
            LabelChange(10, 10, pieces=(("page", "2"), ("note:headnote", "Doe and Roe, A Sample Article"))),  # no-op
        ]
        valid, problems = check_changes(doc, changes, range(10, 16))
        self.assertEqual(valid, changes[:1])
        self.assertEqual([p.reason for p in problems], ["overlap", "outside", "label", "text", "noop", "noop"])

    def test_changes_between(self):
        doc = ZoneDocument(SAMPLE, LABELS)
        wanted = [LabelChange(11, 12, label="listBibl"), LabelChange(10, 10, pieces=(("note:headnote", "2 Doe and Roe,"), ("body", "A Sample Article")))]
        target = changed_pieces(doc, wanted)
        self.assertEqual(changes_between(doc, target, range(len(doc.lines))), [wanted[1], wanted[0]])


class TestApplyLabels(unittest.TestCase):
    def test_no_change_keeps_the_document(self):
        self.assertEqual(apply_labels(SAMPLE, LABELS, [LabelChange(12, 12, label="body")]), SAMPLE)

    def test_relabel_whole_zone_merges_with_neighbours(self):
        # the two body lines of page 3 become listBibl and join the following listBibl zone
        result = apply_labels(SAMPLE, LABELS, [LabelChange(11, 12, label="listBibl")])
        self.assertIn("<listBibl>The second page continues the body <lb/>with more text <lb/>Smith, J. (2020). A book. <lb/>", result)
        self.assertEqual(non_space(result), non_space(SAMPLE))
        doc = ZoneDocument(result, LABELS)
        self.assertEqual([doc.lines[i].label for i in range(11, 15)], ["listBibl"] * 4)

    def test_move_boundary_after_line(self):
        # the first body line moves into the front zone before it
        result = apply_labels(SAMPLE, LABELS, [LabelChange(6, 6, label="front")])
        self.assertIn("continued here. <lb/>1 Introduction <lb/></front>\n    <body>The body starts", result)
        self.assertEqual(non_space(result), non_space(SAMPLE))

    def test_split_zone_in_the_middle(self):
        result = apply_labels(SAMPLE, LABELS, [LabelChange(4, 4, label="body")])
        self.assertIn("<front>A Sample Article <lb/>Jane Doe and John Roe <lb/></front>\n    <body>Abstract. This is \"the\" abstract, <lb/></body>\n    <front>continued here. <lb/></front>", result)
        doc = ZoneDocument(result, LABELS)
        self.assertEqual([doc.lines[i].label for i in range(2, 6)], ["front", "front", "body", "front"])

    def test_pieces_inside_a_line(self):
        change = LabelChange(10, 10, pieces=(("page", "2"), ("note:headnote", "Doe and Roe,"), ("body", "A Sample Article")))
        result = apply_labels(SAMPLE, LABELS, [change])
        self.assertIn('<page>2</page> <note place="headnote">Doe and Roe, </note><body>A Sample Article <lb/>The second page', result)
        self.assertEqual(non_space(result), non_space(SAMPLE))

    def test_text_outside_zones(self):
        result = apply_labels(SAMPLE, LABELS, [LabelChange(15, 15, label="listBibl")])
        self.assertIn("Another book. <lb/>stray text outside <lb/></listBibl>", result)
        back = apply_labels(result, LABELS, [LabelChange(15, 15, label=OUTSIDE)])
        self.assertEqual(ZoneDocument(back, LABELS).lines[15].label, OUTSIDE)
        self.assertEqual(non_space(back), non_space(SAMPLE))

    def test_new_label(self):
        result = apply_labels(SAMPLE, LABELS, [LabelChange(0, 1, label="div:toc")])
        self.assertIn('<div type="toc">Journal of Samples <lb/>Cover page &amp; notes <lb/></div>', result)

    def test_entities_kept(self):
        result = apply_labels(SAMPLE, LABELS, [LabelChange(9, 9, label="body")])
        self.assertIn("1 A footnote &#160;with a reference. <lb/>", result)

    def test_mismatching_pieces_raise(self):
        with self.assertRaises(ValueError):
            apply_labels(SAMPLE, LABELS, [LabelChange(10, 10, pieces=(("page", "3"),))])


class TestPageBreaks(unittest.TestCase):
    def test_page_breaks_carry_no_text(self):
        # lines, pieces and page fingerprints are those of the sample without <pb/>
        self.assertEqual(digest(SAMPLE_PB), json.loads(EXPECTED.read_text(encoding="utf-8")))
        self.assertEqual(non_space(SAMPLE_PB), non_space(SAMPLE))

    def test_page_breaks_and_their_lines(self):
        doc = ZoneDocument(SAMPLE_PB, LABELS)
        self.assertEqual([(pb.n, pb.line) for pb in doc.page_breaks], [("1", 0), ("2", 2), ("3", 10), ("4", 16)])
        self.assertEqual(line_pages_from_page_breaks(doc), LAYOUT["pages"])
        self.assertIsNone(line_pages_from_page_breaks(ZoneDocument(SAMPLE, LABELS)))

    def test_insert_page_breaks(self):
        result, count = insert_page_breaks(SAMPLE, LABELS, LAYOUT["pages"])
        self.assertEqual(count, 4)
        self.assertEqual(text_of(result), text_of(SAMPLE_PB))
        self.assertIn("<page><pb n=\"3\"/>2</page>", result)
        # before the first character of the line, after the <lb/> of the line before
        self.assertIn("<front><pb n=\"2\"/>A Sample Article", result)

    def test_insertion_is_skipped_next_to_existing_page_breaks(self):
        self.assertEqual(insert_page_breaks(SAMPLE_PB, LABELS, LAYOUT["pages"]), (SAMPLE_PB, 0))
        # a <pb/> one line after the page start of page 2 counts for it
        moved = SAMPLE_PB.replace('<pb n="2"/>A Sample Article <lb/>', 'A Sample Article <lb/><pb n="2"/>')
        self.assertEqual(insert_page_breaks(moved, LABELS, LAYOUT["pages"])[1], 0)
        # one too far away does not
        far = SAMPLE_PB.replace('<pb n="2"/>A Sample Article', "A Sample Article").replace("<body>1 Introduction <lb/>The body starts on the first page <lb/>", '<body>1 Introduction <lb/>The body starts on the first page <lb/><pb n="2"/>')
        self.assertEqual(ZoneDocument(far, LABELS).page_breaks[1].line, 8)
        result, count = insert_page_breaks(far, LABELS, LAYOUT["pages"], vicinity=3)
        self.assertEqual(count, 1)
        self.assertIn('<front><pb n="2"/>A Sample Article', result)
        # each existing <pb/> counts for one page start only
        self.assertEqual(insert_page_breaks(SAMPLE, LABELS, [0, 1, 2, 3] + [3] * 14, vicinity=3)[1], 4)
        one = SAMPLE.replace("<titlePage>Journal", '<titlePage><pb n="1"/>Journal')
        self.assertEqual(insert_page_breaks(one, LABELS, [0, 1, 2, 3] + [3] * 14, vicinity=3)[1], 3)

    def test_page_break_inside_a_line_starts_the_next_line(self):
        xml = SAMPLE.replace("Jane Doe and John Roe <lb/>", 'Jane Doe <pb/>and John Roe <lb/>')
        self.assertEqual(ZoneDocument(xml, LABELS).page_breaks[0].line, 4)

    def test_pages_without_numbers(self):
        xml = SAMPLE_PB.replace(' n="1"', "").replace(' n="2"', "").replace(' n="3"', ' n="x"')
        self.assertEqual(line_pages_from_page_breaks(ZoneDocument(xml, LABELS)), LAYOUT["pages"])
        # lines before the first <pb/> belong to the page before it
        xml = SAMPLE_PB.replace('<pb n="1"/>', "")
        self.assertEqual(line_pages_from_page_breaks(ZoneDocument(xml, LABELS)), LAYOUT["pages"])

    def test_page_break_between_zones(self):
        xml = SAMPLE.replace("<page>2</page>", '<pb n="3"/><page>2</page>')
        doc = ZoneDocument(xml, LABELS)
        self.assertEqual(doc.page_breaks[0].line, 10)
        self.assertEqual(doc.lines[10].pieces[0].label, "page")

    def test_non_empty_page_break_is_refused(self):
        with self.assertRaises(ZoneDocumentError):
            ZoneDocument(SAMPLE.replace("<body>1 Introduction", "<body><pb>1</pb> Introduction"), LABELS)

    def test_apply_labels_keeps_page_breaks(self):
        for change in (LabelChange(2, 2, label="titlePage"), LabelChange(10, 10, label="note:headnote"), LabelChange(16, 17, label="body")):
            result = apply_labels(SAMPLE_PB, LABELS, [change])
            self.assertEqual(result.count("<pb "), 4, change)
            self.assertEqual(non_space(result), non_space(SAMPLE_PB))
            doc = ZoneDocument(result, LABELS)
            self.assertEqual(line_pages_from_page_breaks(doc), LAYOUT["pages"], change)
            # labels as without page breaks
            self.assertEqual([line.pieces for line in doc.lines], [line.pieces for line in ZoneDocument(apply_labels(SAMPLE, LABELS, [change]), LABELS).lines])

    def test_prefixed_text(self):
        xml = SAMPLE.replace('<TEI xmlns="http://www.tei-c.org/ns/1.0">', '<tei:TEI xmlns:tei="http://www.tei-c.org/ns/1.0">').replace("</TEI>", "</tei:TEI>").replace('<text xml:lang="en">', '<tei:text xml:lang="en">').replace("</text>", "</tei:text>")
        self.assertIn('<tei:pb n="1"/>', insert_page_breaks(xml, LABELS, LAYOUT["pages"])[0])


if __name__ == "__main__":
    unittest.main()
