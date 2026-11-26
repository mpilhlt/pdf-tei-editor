"""
Unit tests for the LLM correction pass of the OCR text layer.

@testCovers fastapi_app/lib/ocr/llm_correction.py
"""

import asyncio
import json
import shutil
import tempfile
import unittest
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
from unittest import mock

import pikepdf

from fastapi_app.lib.llm.base import LLMProviderError
from fastapi_app.lib.ocr import llm_correction
from fastapi_app.lib.ocr.line_review import LineCorrection, build_user_prompt, letters_similar
from fastapi_app.lib.ocr.llm_correction import (
    REASON_FEW_LETTERS,
    REASON_LETTERS,
    REASON_NUMBER,
    CorrectionRun,
    _marker_change,
    correct_text_layer,
    patches_from_corrections,
    review_lines_for_pages,
)
from fastapi_app.lib.ocr.text_layer import (
    LayerLine,
    LayerPage,
    LayerWord,
    WordPatch,
    layer_lines,
    patch_text_layer,
    read_text_layer,
)
from tests.unit.fastapi.test_text_layer import make_digital_pdf, make_layer_pdf

PROJECT_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = PROJECT_ROOT / "tests" / "unit" / "fastapi" / "fixtures" / "ocr-text-layer.pdf"
FIRST_LINE = "Die Gesellschaft haftet nach der neuen Regel’). Weitere Ausführungen"
LINES_PER_PAGE = 9


def answer(*items: tuple[str, str, str]) -> str:
    """A model answer with the corrections `(line id, old, new)`."""
    return json.dumps([{"line": line, "old": old, "new": new, "rationale": "OCR"} for line, old, new in items])


class FakeProvider:
    """Returns the given answers in turn; an exception in the list is raised instead."""

    def __init__(self, responses: Sequence[str | Exception | None]) -> None:
        self.responses = list(responses)
        self.user_prompts: list[str] = []

    async def chat_completion(
        self, model_id: str, system_prompt: str, user_prompt: str, temperature: float = 0.2
    ) -> str | None:
        self.user_prompts.append(user_prompt)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def fixture_page(index: int) -> LayerPage:
    """Return the words of the fixture's page as page `index`."""
    page = read_text_layer(pikepdf.open(FIXTURE))[0]
    return LayerPage(index, [replace(word, page=index) for word in page.words], page.unpatchable)


def text_line(text: str, page: int = 0, line: int = 0) -> LayerLine:
    """A layer line with the words of `text`."""
    return LayerLine(page, [LayerWord(page, 1, line, i, i + 1, word, line) for i, word in enumerate(text.split())])


def text_page(index: int, lines: int = 3) -> LayerPage:
    """A page whose lines `p<index> l<j>` are drawn in text objects of their own."""
    return LayerPage(index, [w for j in range(lines) for w in text_line(f"p{index} l{j}", index, j).words])


def words(path: Path, page: int) -> list[str]:
    """The words of the text layer of a page of `path`."""
    with pikepdf.open(path) as pdf:
        return [w.text for w in read_text_layer(pdf)[page].words]


class CorrectTextLayerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def make_pdf(self, extra: Sequence[Path] = (), fixture_pages: int = 1) -> Path:
        """
        Copy the fixture into the temp dir, with `fixture_pages` copies of its page and the first page
        of each `extra` PDF.
        """
        path = self.tmp / "doc.pdf"
        shutil.copy(FIXTURE, path)
        if fixture_pages == 1 and not extra:
            return path
        sources = [pikepdf.open(FIXTURE) for _ in range(fixture_pages - 1)] + [pikepdf.open(p) for p in extra]
        with pikepdf.open(FIXTURE) as pdf:
            for source in sources:
                pdf.pages.append(source.pages[0])
            pdf.save(path)
        for source in sources:
            source.close()
        return path

    def run_pass(
        self, path: Path, provider: FakeProvider, selected: list[int], threshold: float = 0.7, max_pages: int = 50
    ) -> CorrectionRun:
        with mock.patch.object(llm_correction, "pages_needing_review", return_value=selected):
            return asyncio.run(correct_text_layer(path, provider, "m", ["de"], threshold, max_pages))  # type: ignore[arg-type]

    def test_marker_corrected_in_text_layer(self) -> None:
        path = self.make_pdf()
        run = self.run_pass(path, FakeProvider([answer(("0001", "Regel’).", "Regel12)."))]), [0])
        self.assertIsNone(run.error)
        self.assertEqual(run.pages_reviewed, [0])
        self.assertEqual([(c.page, c.old, c.new) for c in run.corrections], [(0, "Regel’).", "Regel12).")])
        self.assertEqual(run.skipped, 0)
        self.assertIn("Regel12).", words(path, 0))
        self.assertNotIn("Regel’).", words(path, 0))
        self.assertEqual(list(self.tmp.iterdir()), [path])  # no temp file left

    def test_pages_beyond_the_limit_not_reviewed(self) -> None:
        path = self.make_pdf(fixture_pages=3)
        provider = FakeProvider([answer(("0001", "Regel’).", "Regel12)."))])
        with self.assertLogs("fastapi_app.lib.ocr.llm_correction", level="INFO") as logs:
            run = self.run_pass(path, provider, [0, 1, 2], max_pages=1)
        self.assertIn("2 page(s) not reviewed: the pass reviews at most 1 pages", "\n".join(logs.output))
        self.assertEqual(len(provider.user_prompts), 1)
        self.assertEqual(run.pages_reviewed, [0])
        self.assertEqual(run.pages_over_limit, [1, 2])
        self.assertEqual(run.pages_skipped, [1, 2])
        self.assertEqual((run.pages_selected, run.max_pages, run.found), ([0, 1, 2], 1, 1))
        self.assertEqual([c.new for c in run.corrections], ["Regel12)."])
        self.assertIn("Regel’).", words(path, 1))

    def test_found_counts_corrections_not_applied(self) -> None:
        path = self.make_pdf()
        provider = FakeProvider([answer(("0001", "Regel’).", "Regel12)."), ("0001", "nach der neuen", "nach die neuen"))])
        run = self.run_pass(path, provider, [0])
        self.assertEqual((run.found, len(run.corrections)), (2, 1))

    def test_no_pages_selected_makes_no_call(self) -> None:
        path = self.make_pdf()
        before = path.read_bytes()
        provider = FakeProvider([])
        run = self.run_pass(path, provider, [])
        self.assertEqual(provider.user_prompts, [])
        self.assertEqual((run.corrections, run.pages_reviewed, run.skipped, run.error), ([], [], 0, None))
        self.assertEqual(path.read_bytes(), before)

    def test_provider_failure_keeps_earlier_windows(self) -> None:
        path = self.make_pdf(fixture_pages=3)
        first_of_page_2 = f"{2 * LINES_PER_PAGE + 1:04d}"  # page 1 is numbered too, as context of both windows
        provider = FakeProvider([answer(("0001", "Regel’).", "Regel12).")), LLMProviderError("service down")])
        with self.assertLogs("fastapi_app.lib.ocr.llm_correction", level="WARNING"):
            run = self.run_pass(path, provider, [0, 2])
        self.assertEqual(len(provider.user_prompts), 2)
        self.assertIn(f"{first_of_page_2} | {FIRST_LINE}", provider.user_prompts[1])
        self.assertIsNotNone(run.error)
        self.assertIn("service down", run.error or "")
        self.assertEqual(run.pages_reviewed, [0])
        self.assertEqual([c.new for c in run.corrections], ["Regel12)."])
        self.assertIn("Regel12).", words(path, 0))
        self.assertIn("Regel’).", words(path, 2))

    def test_page_patch_failure_skipped(self) -> None:
        path = self.make_pdf(fixture_pages=2)
        provider = FakeProvider([answer(("0001", "Regel’).", "Regel12)."), ("0010", "Regel’).", "Regel12)."))])

        def fail_on_page_1(pdf: pikepdf.Pdf, patches: Sequence[WordPatch]) -> None:
            if any(p.word.page == 1 for p in patches):
                raise ValueError("font object 1 is shared with another font")
            patch_text_layer(pdf, patches)

        with mock.patch.object(llm_correction, "patch_text_layer", side_effect=fail_on_page_1):
            with self.assertLogs("fastapi_app.lib.ocr.llm_correction", level="WARNING") as logs:
                run = self.run_pass(path, provider, [0, 1])
        self.assertIn("page 2", "\n".join(logs.output))
        self.assertIsNone(run.error)
        self.assertEqual(run.skipped, 1)
        self.assertEqual([c.page for c in run.corrections], [0])
        self.assertIn("Regel12).", words(path, 0))
        self.assertIn("Regel’).", words(path, 1))

    def assert_first_window_kept(self, second: Exception | None) -> None:
        """Window 2 fails with `second` (None: an empty answer); window 1's correction is still applied."""
        path = self.make_pdf(fixture_pages=3)
        provider = FakeProvider([answer(("0001", "Regel’).", "Regel12).")), second])
        with self.assertLogs("fastapi_app.lib.ocr.llm_correction", level="WARNING"):
            run = self.run_pass(path, provider, [0, 2])
        self.assertIsNotNone(run.error)
        self.assertEqual(run.pages_reviewed, [0])
        self.assertEqual([c.new for c in run.corrections], ["Regel12)."])
        self.assertIn("Regel12).", words(path, 0))

    def test_empty_answer_keeps_earlier_windows(self) -> None:
        self.assert_first_window_kept(None)

    def test_unexpected_error_keeps_earlier_windows(self) -> None:
        self.assert_first_window_kept(KeyError("message"))

    def test_unexpected_patch_error_skips_only_its_page(self) -> None:
        path = self.make_pdf(fixture_pages=2)
        provider = FakeProvider([answer(("0001", "Regel’).", "Regel12)."), ("0010", "Regel’).", "Regel12)."))])

        def fail_on_page_0(pdf: pikepdf.Pdf, patches: Sequence[WordPatch]) -> None:
            if any(p.word.page == 0 for p in patches):
                raise RuntimeError("unexpected")
            patch_text_layer(pdf, patches)

        with mock.patch.object(llm_correction, "patch_text_layer", side_effect=fail_on_page_0):
            with self.assertLogs("fastapi_app.lib.ocr.llm_correction", level="WARNING"):
                run = self.run_pass(path, provider, [0, 1])
        self.assertEqual(run.skipped, 1)
        self.assertEqual([c.page for c in run.corrections], [1])
        self.assertIn("Regel’).", words(path, 0))
        self.assertIn("Regel12).", words(path, 1))

    def test_save_failure_reports_error(self) -> None:
        path = self.make_pdf()
        before = path.read_bytes()
        provider = FakeProvider([answer(("0001", "Regel’).", "Regel12)."))])
        with mock.patch.object(pikepdf.Pdf, "save", side_effect=RuntimeError("disk on fire")):
            with self.assertLogs("fastapi_app.lib.ocr.llm_correction", level="WARNING"):
                run = self.run_pass(path, provider, [0])
        self.assertIn("disk on fire", run.error or "")
        self.assertEqual((run.corrections, run.skipped), ([], 1))
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(list(self.tmp.iterdir()), [path])

    def test_stricter_threshold_drops_rewrite(self) -> None:
        corrections = [("0005", "Gesetz", "Gesetze"), ("0007", "Begründung", "Bedrängung")]  # ratios 0.92 and 0.6
        path = self.make_pdf()
        run = self.run_pass(path, FakeProvider([answer(*corrections)]), [0], threshold=0.7)
        self.assertEqual([c.new for c in run.corrections], ["Gesetze"])
        path.unlink()
        path = self.make_pdf()
        run = self.run_pass(path, FakeProvider([answer(*corrections)]), [0], threshold=0.5)
        self.assertEqual([c.new for c in run.corrections], ["Gesetze", "Bedrängung"])

    def test_selected_page_with_visible_text_not_reviewed(self) -> None:
        digital = self.tmp / "digital.pdf"
        make_digital_pdf(digital)
        path = self.make_pdf(extra=[digital])
        digital.unlink()
        provider = FakeProvider([answer()])
        with self.assertLogs("fastapi_app.lib.ocr.llm_correction", level="INFO") as logs:
            run = self.run_pass(path, provider, [0, 1])
        self.assertIn("visible text", "\n".join(logs.output))
        self.assertEqual(run.pages_skipped, [1])
        self.assertEqual(run.pages_reviewed, [0])
        self.assertEqual(len(provider.user_prompts), 1)
        self.assertNotIn("Hello", provider.user_prompts[0])

    def test_page_without_line_structure_not_reviewed(self) -> None:
        one_object = self.tmp / "one-object.pdf"
        make_layer_pdf(one_object, b"BT 3 Tr /F1 10 Tf <" + b"0044 0020 " * 81 + b"> Tj ET")
        path = self.make_pdf(extra=[one_object])
        one_object.unlink()
        provider = FakeProvider([])
        with self.assertLogs("fastapi_app.lib.ocr.llm_correction", level="INFO") as logs:
            run = self.run_pass(path, provider, [1])
        self.assertIn("80 words", "\n".join(logs.output))
        self.assertEqual(run.pages_skipped, [1])
        self.assertEqual(run.pages_reviewed, [])
        self.assertEqual(provider.user_prompts, [])

    def test_unreadable_pdf_reports_error(self) -> None:
        path = self.tmp / "broken.pdf"
        path.write_bytes(b"not a pdf")
        with self.assertLogs("fastapi_app.lib.ocr.llm_correction", level="WARNING"):
            run = asyncio.run(correct_text_layer(path, FakeProvider([]), "m", [], 0.7))  # type: ignore[arg-type]
        self.assertIsNotNone(run.error)
        self.assertEqual(path.read_bytes(), b"not a pdf")


class ReviewLinesForPagesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.page = read_text_layer(pikepdf.open(FIXTURE))[0]
        self.lines = layer_lines(self.page)

    def test_review_lines_windows_split_on_gaps(self) -> None:
        pages = [fixture_page(i) for i in range(4)]
        review, lines = review_lines_for_pages(pages, [0, 1, 3], ["de"])
        per_page = len(self.lines)
        self.assertEqual(len(review.texts), 4 * per_page)  # page 2 as context of both windows
        self.assertEqual(review.texts[per_page], FIRST_LINE)
        self.assertEqual(review.windows, [range(0, 2 * per_page), range(3 * per_page, 4 * per_page)])
        self.assertEqual(review.context, [range(0, 3 * per_page), range(2 * per_page, 4 * per_page)])
        self.assertEqual({lines[i].page for i in review.windows[0]}, {0, 1})
        self.assertEqual({lines[i].page for i in review.windows[1]}, {3})
        self.assertEqual(review.languages, ["de"])

    def test_context_only_from_adjacent_pages(self) -> None:
        pages = [text_page(i) for i in range(12)]
        review, lines = review_lines_for_pages(pages, [3, 10], [])
        self.assertEqual(sorted({line.page for line in lines}), [2, 3, 4, 9, 10, 11])
        second = build_user_prompt(review, review.windows[1], (2, 2))
        self.assertIn("p9 l2", second)
        self.assertIn("p11 l0", second)
        self.assertNotIn("p3 ", second)
        self.assertNotIn("p4 ", second)
        first = build_user_prompt(review, review.windows[0], (1, 2))
        self.assertIn("p2 l0", first)
        self.assertIn("p4 l2", first)
        self.assertNotIn("p9 ", first)

    def test_page_between_two_runs_numbered_once(self) -> None:
        pages = [text_page(i) for i in range(6)]
        review, lines = review_lines_for_pages(pages, [3, 5], [])
        self.assertEqual([line.page for line in lines], [2] * 3 + [3] * 3 + [4] * 3 + [5] * 3)
        second = build_user_prompt(review, review.windows[1], (2, 2))
        self.assertIn("p4 l0", second)
        self.assertNotIn("p3 ", second)

    def test_unreviewable_neighbour_not_context(self) -> None:
        pages = [text_page(0), text_page(1), text_page(2)]
        pages[0].unpatchable = "visible text"
        _, lines = review_lines_for_pages(pages, [1], [])
        self.assertEqual(sorted({line.page for line in lines}), [1, 2])

    def test_review_lines_windows_hold_at_most_two_pages(self) -> None:
        pages = [fixture_page(i) for i in range(3)]
        review, lines = review_lines_for_pages(pages, [0, 1, 2], [])
        self.assertEqual([sorted({lines[i].page for i in w}) for w in review.windows], [[0, 1], [2]])


class PatchesFromCorrectionsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.page = read_text_layer(pikepdf.open(FIXTURE))[0]
        self.lines = layer_lines(self.page)

    def test_patch_from_whole_word_correction(self) -> None:
        patches, dropped = patches_from_corrections(self.lines, [LineCorrection(0, "Regel’).", "Regel12).", "")], 0.7)
        word = next(w for w in self.page.words if w.text == "Regel’).")
        self.assertEqual(patches, [WordPatch(word, "Regel12).")])
        self.assertEqual(dropped, [])

    def test_partial_word_correction_dropped(self) -> None:
        patches, dropped = patches_from_corrections(self.lines, [LineCorrection(0, "egel’)", "egel12)", "")], 0.7)
        self.assertEqual(patches, [])
        self.assertEqual(len(dropped), 1)
        self.assertIn("not whole words", dropped[0])

    def test_correction_occurring_twice_dropped(self) -> None:
        line = LayerLine(0, [LayerWord(0, 1, 0, i * 4, i * 4 + 3, w, 0) for i, w in enumerate("der und der".split())])
        patches, dropped = patches_from_corrections([line], [LineCorrection(0, "der", "den", "")], 0.7)
        self.assertEqual(patches, [])
        self.assertIn("not whole words", dropped[0])

    def test_multi_word_correction_patches_only_changed_words(self) -> None:
        correction = LineCorrection(0, "neuen Regel’). Weitere", "neuen Regel12). Weitere", "")
        patches, dropped = patches_from_corrections(self.lines, [correction], 0.7)
        self.assertEqual([(p.word.text, p.new_text) for p in patches], [("Regel’).", "Regel12).")])
        self.assertEqual(dropped, [])

    def test_conflicting_correction_dropped(self) -> None:
        corrections = [
            LineCorrection(0, "Regel’).", "Regel12).", ""),
            LineCorrection(0, "Regel’).", "Regel12).", ""),
            LineCorrection(0, "neuen Regel’).", "neuen Regel13).", ""),
        ]
        patches, dropped = patches_from_corrections(self.lines, corrections, 0.7)
        self.assertEqual([p.new_text for p in patches], ["Regel12)."])
        self.assertEqual(len(dropped), 1)
        self.assertIn("conflicts", dropped[0])

    def assert_kept(self, old: str, new: str, text: str | None = None) -> None:
        patches, dropped = patches_from_corrections([text_line(text or old)], [LineCorrection(0, old, new, "")], 0.7)
        self.assertEqual(dropped, [])
        self.assertTrue(patches)

    def assert_dropped(self, old: str, new: str, reason: str, text: str | None = None) -> None:
        patches, dropped = patches_from_corrections([text_line(text or old)], [LineCorrection(0, old, new, "")], 0.7)
        self.assertEqual(patches, [])
        self.assertEqual(len(dropped), 1)
        self.assertIn(reason, dropped[0])

    def test_each_changed_word_must_be_similar(self) -> None:
        old, new = "in der Regel’) zu finden", "in die Regel12) zu finden"
        self.assertTrue(letters_similar(old, new, 0.7))  # the span as a whole passes
        self.assertFalse(letters_similar("der", "die", 0.7))
        self.assert_dropped(old, new, REASON_LETTERS)

    def test_marker_shapes_with_and_without_bracket(self) -> None:
        for old, new in [
            ("tut?!?", "tut312"),
            ("tut?!?)", "tut312)"),
            ('stellen?">).', "stellen313)."),
            ('stellen?">.', "stellen313."),
            ("würde‘.", "würde165."),
            ("würde‘).", "würde165)."),
            ("Regel’).", "Regel12)."),
            ("Regel’", "Regel12"),
            ("?!", "12"),
            ("?!?)", "312)"),
            ("*,", "7,"),
        ]:
            self.assertTrue(_marker_change(old, new), (old, new))
        for old, new in [("1920", "1926"), ("12", "13"), ("3a", "3b"), ("Regel", "Regel12"), ("tut?!?!?", "tut3"),
                         ("(’)", "(1)"), ("ab’).", "ac1)."), ("?!", "1234")]:
            self.assertFalse(_marker_change(old, new), (old, new))

    def test_marker_changes_of_words_without_letters_kept(self) -> None:
        self.assert_kept("?!?)", "312)", "siehe ?!?) unten")
        self.assert_kept("?!", "12", "siehe ?! unten")
        self.assert_kept("*,", "7,", "Text *, mehr")
        self.assert_kept("ab’).", "ab12).")
        self.assert_kept("ab’", "ab1")
        self.assert_kept("Regel’).", "Regel12).")
        self.assert_kept("tut?!?", "tut312")

    def test_number_changes_outside_markers_dropped(self) -> None:
        self.assert_dropped("1920", "1926", REASON_NUMBER, "im Jahre 1920 erlassen")
        self.assert_dropped("S. 12", "S. 13", REASON_NUMBER, "vgl. S. 12 oben")
        self.assert_dropped("12", "13", REASON_NUMBER, "Fußnote 12 oben")
        self.assert_dropped("3a", "3b", REASON_NUMBER, "Art. 3a GG")
        self.assert_dropped("zu", "zur", REASON_FEW_LETTERS, "zu finden")

    def test_patches_apply_to_the_fixture(self) -> None:
        patches, _ = patches_from_corrections(self.lines, [LineCorrection(0, "Regel’).", "Regel12).", "")], 0.7)
        pdf = pikepdf.open(FIXTURE)
        patch_text_layer(pdf, patches)
        self.assertIn("Regel12).", [w.text for w in read_text_layer(pdf)[0].words])


if __name__ == "__main__":
    unittest.main()
