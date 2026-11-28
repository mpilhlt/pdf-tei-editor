"""
Unit tests for converting the text of a PDF to outlines and the replacement chain of the
OCRmyPDF engine (vectorize, falling back to rasterizing).

@testCovers fastapi_app/plugins/ocrmypdf/vectorize.py
@testCovers fastapi_app/plugins/ocrmypdf/engine.py
"""

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pikepdf
import pypdfium2 as pdfium

from fastapi_app.lib.ocr.layout_check import check_text_layout
from fastapi_app.lib.ocr.text_quality import analyze_text_layer
from fastapi_app.plugins.ocrmypdf import vectorize
from fastapi_app.plugins.ocrmypdf.engine import OcrmypdfEngine

PROJECT_ROOT = Path(__file__).resolve().parents[4]
TEXT_PDF = PROJECT_ROOT / "tests" / "e2e" / "fixtures" / "pdf" / "test-document.pdf"
FIXTURES = Path(__file__).parent / "fixtures"
"""Fixture PDFs, created by fixtures/make_fixtures.py."""

# A glyph-like filled path in the form Ghostscript writes it, relative to its first point
GLYPH = [(0, 0, "m"), (10, 0, "l"), (10, 20, "l"), (8, 25, 2, 25, 0, 20, "c"), "h", "f"]


def glyph_lines(x: float, y: float) -> list[str]:
    """Return the content stream lines of GLYPH at a position."""
    lines = []
    for item in GLYPH:
        if isinstance(item, str):
            lines.append(item)
            continue
        *coords, operator = item
        moved = [c + (x if i % 2 == 0 else y) for i, c in enumerate(coords)]
        lines.append(" ".join(f"{c:g}" for c in moved) + f" {operator}")
    return lines


def make_vector_pdf(path: Path, positions: list[tuple[float, float]]) -> None:
    """Write a one-page PDF that draws GLYPH at the given positions, plus a single other path."""
    lines = ["0 0 0 rg"]
    for x, y in positions:
        lines += glyph_lines(x, y)
    lines += ["100 100 m", "150 100 l", "150 160 l", "h", "f"]
    with pikepdf.new() as pdf:
        pdf.add_blank_page(page_size=(300, 300))
        pdf.pages[0].obj.Contents = pdf.make_stream("\n".join(lines).encode())
        pdf.save(path)


def render(path: Path) -> bytes:
    """Render the first page of a PDF to raw grey pixels."""
    document = pdfium.PdfDocument(str(path))
    try:
        return document[0].render(scale=1, grayscale=True).to_pil().convert("L").tobytes()
    finally:
        document.close()


class TestCompactGlyphPaths(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_repeated_paths_become_form_xobjects(self):
        source, target = self.tmp / "in.pdf", self.tmp / "out.pdf"
        make_vector_pdf(source, [(20 + i * 15, 200) for i in range(10)] + [(20.5, 50.25)])
        self.assertEqual(vectorize.compact_glyph_paths(source, target), 1)
        with pikepdf.open(target) as pdf:
            page = pdf.pages[0]
            names = [str(name) for name in page.Resources.XObject.keys()]
            self.assertEqual(names, [f"/{vectorize.GLYPH_PREFIX}0"])
            content = page.obj.Contents.read_bytes()
            self.assertEqual(content.count(b" Do Q"), 11)
            # the path that occurs once stays inline
            self.assertIn(b"150 160 l", content)
        self.assertSimilar(source, target)

    def assertSimilar(self, a: Path, b: Path) -> None:
        """Assert that two PDFs render nearly the same (anti-aliasing may differ slightly)."""
        pixels_a, pixels_b = render(a), render(b)
        self.assertEqual(len(pixels_a), len(pixels_b))
        differences = [abs(x - y) for x, y in zip(pixels_a, pixels_b) if x != y]
        self.assertLess(max(differences, default=0), 64, "rendering differs")
        self.assertLess(len(differences), len(pixels_a) * 0.001)

    def test_without_repeated_paths_nothing_changes(self):
        source, target = self.tmp / "in.pdf", self.tmp / "out.pdf"
        make_vector_pdf(source, [(20, 200)])
        self.assertEqual(vectorize.compact_glyph_paths(source, target), 0)
        self.assertEqual(render(source), render(target))


class TestVerifyOutlined(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_text_left_over(self):
        reason = vectorize.verify_outlined(TEXT_PDF, TEXT_PDF)
        self.assertIsNotNone(reason)
        self.assertIn("could not be converted to outlines", reason or "")

    def test_page_count_changed(self):
        with pikepdf.open(TEXT_PDF) as pdf:
            del pdf.pages[-1]
            pdf.save(self.tmp / "short.pdf")
        self.assertIn("page count", vectorize.verify_outlined(TEXT_PDF, self.tmp / "short.pdf") or "")

    def test_changed_appearance(self):
        with pikepdf.open(TEXT_PDF) as pdf:
            for page in pdf.pages:
                page.obj.Contents = pdf.make_stream(b"")
            pdf.save(self.tmp / "blank.pdf")
        self.assertIn("looks different", vectorize.verify_outlined(TEXT_PDF, self.tmp / "blank.pdf") or "")

    def test_file_size(self):
        source, target = self.tmp / "in.pdf", self.tmp / "out.pdf"
        make_vector_pdf(source, [(20, 200)])
        # a small file may grow by more than MAX_SIZE_FACTOR up to the allowance per page
        target.write_bytes(source.read_bytes() + b"\n%" + b"x" * int(source.stat().st_size * vectorize.MAX_SIZE_FACTOR))
        self.assertIsNone(vectorize.verify_outlined(source, target))
        target.write_bytes(source.read_bytes() + b"\n%" + b"x" * vectorize.SIZE_ALLOWANCE_PER_PAGE)
        self.assertIn("times larger", vectorize.verify_outlined(source, target) or "")

    def test_unchanged_vector_pdf_passes(self):
        source = self.tmp / "in.pdf"
        make_vector_pdf(source, [(20 + i * 15, 200) for i in range(10)])
        self.assertIsNone(vectorize.verify_outlined(source, source))


@unittest.skipUnless(vectorize.ghostscript_available(), "Ghostscript is not installed")
class TestOutlineText(unittest.TestCase):
    def test_outlining_removes_the_text_and_keeps_the_appearance(self):
        with tempfile.TemporaryDirectory() as tmp:
            outlined, compacted = Path(tmp) / "gs.pdf", Path(tmp) / "out.pdf"
            vectorize.outline_text(TEXT_PDF, outlined, page_count=5)
            self.assertGreater(vectorize.compact_glyph_paths(outlined, compacted), 50)
            self.assertIsNone(vectorize.verify_outlined(TEXT_PDF, compacted))


@unittest.skipUnless(vectorize.ghostscript_available() and shutil.which("tesseract"), "Ghostscript or Tesseract is not installed")
class TestRepairIntegration(unittest.TestCase):
    """Detection and replacement of broken text layers with the real tools (takes about 20 seconds)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.engine = OcrmypdfEngine()

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def layout_check(self, path: Path):
        return check_text_layout(path, lambda image: self.engine.recognize_words(image, ["en"]))

    def test_layout_check_finds_misplaced_text(self):
        result = self.layout_check(FIXTURES / "misplaced-text.pdf")
        self.assertEqual(result.pages_checked, [0])
        assert result.text_match is not None and result.position_match is not None
        self.assertGreater(result.text_match, 0.9)
        self.assertLess(result.position_match, 0.3)
        self.assertEqual(len(result.reasons), 1)

    def test_rebuild_replaces_misplaced_text(self):
        output = self.tmp / "out.pdf"
        # without rebuild, a text layer that looks fine is left alone
        self.assertEqual(self.engine.recognize(FIXTURES / "misplaced-text.pdf", output, ["en"], {}).method, "skip")
        result = self.engine.recognize(FIXTURES / "misplaced-text.pdf", output, ["en"], {}, rebuild=True)
        self.assertEqual((result.method, result.fallback_reason), ("vectorize", None))
        self.assertEqual(analyze_text_layer(output).status, "good")
        layout = self.layout_check(output)
        self.assertEqual(layout.reasons, [])
        self.assertGreater(layout.position_match or 0, 0.9)

    def test_garbled_text_is_replaced(self):
        output = self.tmp / "out.pdf"
        self.assertEqual(analyze_text_layer(FIXTURES / "broken-tounicode.pdf").status, "poor")
        result = self.engine.recognize(FIXTURES / "broken-tounicode.pdf", output, ["en"], {})
        self.assertEqual((result.method, result.fallback_reason), ("vectorize", None))
        quality = analyze_text_layer(output)
        self.assertEqual(quality.status, "good")
        self.assertEqual(quality.ocr_layer_pages, 1)


class TestReplacementChain(unittest.TestCase):
    """The vectorize mode with mocked OCR runs."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.engine = OcrmypdfEngine()
        self.runs: list[tuple[str, str]] = []
        patches = [
            patch.object(OcrmypdfEngine, "_tesseract_languages", lambda self, languages, model="fast": ["eng"]),
            patch.object(OcrmypdfEngine, "_run_ocrmypdf", staticmethod(self._fake_run)),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def _fake_run(self, input_path: Path, output_path: Path, languages: list[str], mode: str, deskew: bool, options: dict) -> None:
        self.runs.append((input_path.name, mode))
        shutil.copy(input_path, output_path)

    def recognize(self, source: Path = TEXT_PDF, **options):
        return self.engine.recognize(source, self.tmp / "out.pdf", ["en"], {"mode": "vectorize", **options})

    def test_vectorize(self):
        with patch.object(vectorize, "ghostscript_available", return_value=True), \
                patch.object(vectorize, "outline_text", lambda source, target, pages: shutil.copy(source, target)), \
                patch.object(vectorize, "verify_outlined", return_value=None):
            result = self.recognize()
        self.assertEqual((result.method, result.fallback_reason), ("vectorize", None))
        self.assertEqual(self.runs, [("outlined.pdf", "skip")])

    def test_fallback_without_ghostscript(self):
        with patch.object(vectorize, "ghostscript_available", return_value=False):
            result = self.recognize()
        self.assertEqual((result.method, result.fallback_reason), ("force", "Ghostscript is not installed"))
        self.assertEqual(self.runs, [(TEXT_PDF.name, "force")])
        self.assertIn("converted to images", result.message or "")

    def test_fallback_if_verification_fails(self):
        with patch.object(vectorize, "ghostscript_available", return_value=True), \
                patch.object(vectorize, "outline_text", lambda source, target, pages: shutil.copy(source, target)), \
                patch.object(vectorize, "verify_outlined", return_value="page 2 looks different"):
            result = self.recognize()
        self.assertEqual((result.method, result.fallback_reason), ("force", "page 2 looks different"))
        self.assertEqual(self.runs, [(TEXT_PDF.name, "force")])

    def test_fallback_if_ghostscript_fails(self):
        def fail(source, target, pages):
            raise RuntimeError("Ghostscript failed: broken")

        with patch.object(vectorize, "ghostscript_available", return_value=True), \
                patch.object(vectorize, "outline_text", fail), \
                self.assertLogs("fastapi_app.plugins.ocrmypdf.engine", level="WARNING"):
            result = self.recognize()
        self.assertEqual(result.method, "force")
        self.assertIn("Ghostscript failed", result.fallback_reason or "")

    def test_fallback_for_encrypted_pdf(self):
        encrypted = self.tmp / "encrypted.pdf"
        with pikepdf.open(TEXT_PDF) as pdf:
            pdf.save(encrypted, encryption=pikepdf.Encryption(owner="secret", user=""))
        with patch.object(vectorize, "ghostscript_available", return_value=True):
            result = self.recognize(encrypted)
        self.assertEqual((result.method, result.fallback_reason), ("force", "the PDF is encrypted"))
        # OCRmyPDF gets a decrypted copy
        self.assertEqual(self.runs, [("decrypted.pdf", "force")])

    def test_password_protected_pdf(self):
        protected = self.tmp / "protected.pdf"
        with pikepdf.open(TEXT_PDF) as pdf:
            pdf.save(protected, encryption=pikepdf.Encryption(owner="secret", user="user"))
        with self.assertRaisesRegex(ValueError, "password"):
            self.recognize(protected)

    def test_no_fallback_if_rasterizing_is_not_allowed(self):
        with patch.object(vectorize, "ghostscript_available", return_value=False):
            with self.assertRaisesRegex(ValueError, "without rasterizing"):
                self.recognize(rasterize_fallback=False)
        self.assertEqual(self.runs, [])


if __name__ == "__main__":
    unittest.main()
