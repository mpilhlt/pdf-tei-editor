"""
Unit tests for deriving text layer corrections from the TEI.

@testCovers fastapi_app/lib/ocr/text_corrections.py
"""

import unittest
from unittest.mock import patch

from fastapi_app.lib.ocr.text_corrections import CorrectionPlan, TeiWord, derive_corrections, tei_words
from fastapi_app.lib.ocr.text_layer import LayerPage, LayerWord
from fastapi_app.lib.tei.layout import LineLayout
from fastapi_app.lib.tei.zone_lines import ZoneLabel


def tei(page: int, text: str, line: int = 0) -> dict[int, list[TeiWord]]:
    return {page: [TeiWord(page, line, w) for w in text.split()]}


def layer(page: int, text: str, unpatchable: str | None = None) -> list[LayerPage]:
    words = [LayerWord(page, 1, 0, i * 10, i * 10 + len(w), w) for i, w in enumerate(text.split())]
    return [LayerPage(page, words, unpatchable)]


class TestDeriveCorrections(unittest.TestCase):
    def test_equal_length_replace_gives_corrections(self):
        plan = derive_corrections(tei(0, "nach der neuen Regel12). Weitere"), layer(0, "nach der neuen Regel’). Weitere"))
        self.assertEqual([(c.old, c.new) for c in plan.corrections], [("Regel’).", "Regel12).")])
        self.assertEqual(plan.unwritable, [])

    def test_tokenization_differences_are_ignored(self):
        self.assertEqual(derive_corrections(tei(0, "a Regel’) . b"), layer(0, "a Regel’). b")), CorrectionPlan([], []))

    def test_moved_block_is_ignored(self):
        self.assertEqual(derive_corrections(tei(0, "C D A B"), layer(0, "A B C D")).unwritable, [])

    def test_word_count_change_is_unwritable(self):
        plan = derive_corrections(tei(0, "x Rechtswissenschaft y"), layer(0, "x Rechts- wissenschaft y"))
        self.assertEqual(plan.unwritable[0].reason, "different number of words")
        self.assertEqual((plan.unwritable[0].layer_text, plan.unwritable[0].tei_text), ("Rechts- wissenschaft", "Rechtswissenschaft"))

    def test_unpatchable_page(self):
        plan = derive_corrections(tei(1, "a b2"), layer(1, "a b", unpatchable="visible text"))
        self.assertEqual((plan.corrections, plan.unwritable[0].reason), ([], "visible text"))

    def test_nfc_equal_words_are_not_corrections(self):
        self.assertEqual(derive_corrections(tei(0, "ü"), layer(0, "ü")), CorrectionPlan([], []))


class TestTeiWords(unittest.TestCase):
    def test_words_are_grouped_by_page_of_their_line(self):
        xml = '<TEI xmlns="http://www.tei-c.org/ns/1.0"><text><body><lb/>eins zwei<lb/>drei<lb/>vier fünf</body></text></TEI>'
        labels = [ZoneLabel("body", "body")]
        layout = LineLayout(pages=[0, 0, 1])
        with patch("fastapi_app.lib.ocr.text_corrections.get_zone_labels", return_value=labels):
            words = tei_words(xml, "v", layout)
        self.assertEqual({p: [w.text for w in ws] for p, ws in words.items()}, {0: ["eins", "zwei", "drei"], 1: ["vier", "fünf"]})
        self.assertEqual([w.line for w in words[1]], [2, 2])

    def test_variant_without_zone_labels_raises(self):
        with patch("fastapi_app.lib.ocr.text_corrections.get_zone_labels", return_value=None):
            with self.assertRaises(ValueError):
                tei_words("<TEI/>", "v", LineLayout(pages=[]))


if __name__ == "__main__":
    unittest.main()
