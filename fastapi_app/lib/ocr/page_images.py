"""
Page images of a PDF for vision models: the LLM review of OCR errors sends them along with the
lines of a page window when the model accepts images (`LLMProvider.supports_image_input()`).

Pure module: no FastAPI imports.
"""

from __future__ import annotations

import io
from collections.abc import Sequence
from pathlib import Path

import pypdfium2 as pdfium

from fastapi_app.lib.llm.base import LLMImage

MAX_IMAGE_EDGE_PX = 1800
"""
The longer edge of a page image. Enough to read footnote markers and small print; larger images
exceed the per-image limits of some vision models and only cost tokens.
"""
MAX_SCALE = 4.0
"""The largest scale (relative to 72 dpi) a small page is rendered at."""
JPEG_QUALITY = 80


def render_page_images(pdf_path: Path, page_indices: Sequence[int]) -> list[LLMImage]:
    """
    Render the given pages (0-based, in the given order) of `pdf_path` as grayscale JPEGs whose
    longer edge is at most MAX_IMAGE_EDGE_PX. Blocking.

    Raises:
        IndexError: a page index is out of range.
        pdfium.PdfiumError: the PDF cannot be read or a page cannot be rendered.
    """
    images: list[LLMImage] = []
    document = pdfium.PdfDocument(str(pdf_path))
    try:
        for index in page_indices:
            if not 0 <= index < len(document):
                raise IndexError(f"Page {index + 1} is not in the PDF ({len(document)} pages)")
            page = document[index]
            try:
                width, height = page.get_size()
                scale = min(MAX_IMAGE_EDGE_PX / max(width, height, 1.0), MAX_SCALE)
                # pypdfium2 annotates scale as int, but accepts floats
                image = page.render(scale=scale, grayscale=True).to_pil()  # pyright: ignore[reportArgumentType]
            finally:
                page.close()
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=JPEG_QUALITY)
            images.append(LLMImage(data=buffer.getvalue(), media_type="image/jpeg"))
    finally:
        document.close()
    return images
