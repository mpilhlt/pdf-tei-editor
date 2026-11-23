"""
Create the fixture PDFs for the OCRmyPDF engine tests.

Run from the project root (requires Ghostscript):

    uv run python fastapi_app/plugins/ocrmypdf/tests/fixtures/make_fixtures.py

- broken-tounicode.pdf: digital text whose ToUnicode map points to private use
  characters, so the page looks fine but the extracted text is garbled
- misplaced-text.pdf: the page shows the text as vector outlines, and a text
  layer with the same words is drawn in white, shifted down by two lines
- footnote-markers.pdf: German text with superscript footnote markers in the
  style `Regel¹²)` and the footnotes `12) ...` below (#904)
"""

import subprocess
import tempfile
from pathlib import Path

import pikepdf
from fpdf import FPDF

HERE = Path(__file__).parent

PARAGRAPHS = [
    "Text recognition turns the image of a page into machine readable text. The quality of the result depends on the resolution of the scan, the typeface and the language model that is used for the recognition.",
    "Digital documents usually carry a text layer that was written when the document was created. This layer can be broken: the characters can be mapped to the wrong code points, or the text can be stored at other places than where it is shown on the page.",
    "A broken text layer is replaced by converting the visible text to outlines and recognizing the page again. The outlines keep the appearance of the page, and the new text layer matches what the reader sees.",
]


def write_text_pdf(path: Path, color: tuple[int, int, int] = (0, 0, 0), offset: float = 0.0) -> None:
    """Write a one-page A5 PDF with the paragraphs in Helvetica."""
    pdf = FPDF(format="A5")
    pdf.set_margins(15, 20)
    pdf.add_page()
    pdf.set_font("Helvetica", size=11)
    pdf.set_text_color(*color)
    pdf.set_y(20 + offset)
    for paragraph in PARAGRAPHS:
        pdf.multi_cell(0, 6, paragraph)
        pdf.ln(4)
    pdf.output(str(path))


def make_broken_tounicode(target: Path) -> None:
    """Write a PDF whose ToUnicode map points all printable ASCII codes to private use characters."""
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "text.pdf"
        write_text_pdf(source)
        cmap = b"""/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Broken def
/CMapType 2 def
1 begincodespacerange
<00> <FF>
endcodespacerange
1 beginbfrange
<20> <7E> <E020>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end
"""
        with pikepdf.open(source) as pdf:
            for font in pdf.pages[0].Resources.Font.values():
                font.ToUnicode = pdf.make_stream(cmap)
            pdf.save(target)


def make_misplaced_text(target: Path) -> None:
    """Write a PDF that shows the text as outlines and has a white text layer two lines lower."""
    with tempfile.TemporaryDirectory() as tmp:
        visible, outlined, layer = Path(tmp) / "visible.pdf", Path(tmp) / "outlined.pdf", Path(tmp) / "layer.pdf"
        write_text_pdf(visible)
        subprocess.run(["gs", "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite", "-dNoOutputFonts", f"-sOutputFile={outlined}", str(visible)], check=True)
        write_text_pdf(layer, color=(255, 255, 255), offset=12)
        with pikepdf.open(outlined) as pdf, pikepdf.open(layer) as text:
            pdf.pages[0].add_underlay(pdf.copy_foreign(text.pages[0].as_form_xobject()))
            pdf.save(target)


FOOTNOTE_SENTENCES = [
    ("Die Gesellschaft haftet nach der neuen Regel", "12"),
    ("und die Gesellschafter haften daneben persönlich", "13"),
    ("wie es das Gesetz jetzt ausdrücklich vorsieht", "14"),
]


def make_footnote_markers(target: Path) -> None:
    """Write a PDF with superscript footnote markers like `Regel¹²)`, which Tesseract reads as punctuation, and the footnotes."""
    pdf = FPDF(format="A5")
    pdf.set_margins(15, 20)
    pdf.add_page()
    for text, marker in FOOTNOTE_SENTENCES:
        pdf.set_font("Times", size=11)
        pdf.write(6, text)
        pdf.set_font("Times", size=7)
        pdf.char_vpos = "SUP"
        pdf.write(6, marker)
        pdf.char_vpos = "LINE"
        pdf.set_font("Times", size=11)
        pdf.write(6, "). Weitere Ausführungen folgen im nächsten Abschnitt der Darstellung.\n")
    pdf.ln(10)
    pdf.set_font("Times", size=9)
    for _, marker in FOOTNOTE_SENTENCES:
        pdf.write(5, f"{marker}) Vgl. die Begründung des Entwurfs, S. {marker}0.\n")
    pdf.output(str(target))


if __name__ == "__main__":
    make_broken_tounicode(HERE / "broken-tounicode.pdf")
    make_misplaced_text(HERE / "misplaced-text.pdf")
    make_footnote_markers(HERE / "footnote-markers.pdf")
    print("Fixtures written to", HERE)
