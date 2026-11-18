"""
OCR engine based on OCRmyPDF, which runs Tesseract and writes the recognized
text as an invisible layer on top of the page images, without changing the page
geometry.

Requires the `tesseract` binary with the language data packages
(`tesseract-ocr-<lang>` on Debian).
"""

import logging
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Optional

from fastapi_app.lib.ocr.base import OcrEngine, OcrOption, OcrOptionValue
from fastapi_app.lib.ocr.languages import ISO639_1_TO_3, normalize_ocr_language
from fastapi_app.lib.ocr.text_quality import analyze_text_layer

logger = logging.getLogger(__name__)

TESSERACT_SPECIAL_CODES: dict[str, str] = {
    "aze_cyrl": "az-Cyrl",
    "chi_sim": "zh-Hans",
    "chi_tra": "zh-Hant",
    "deu_latf": "de-Latf",
    "frk": "de-Latf",
    "srp": "sr-Cyrl",
    "srp_latn": "sr-Latn",
    "uzb": "uz-Latn",
    "uzb_cyrl": "uz-Cyrl",
}
"""Tesseract language models that need a script subtag or have a non-standard code."""

TESSERACT_IGNORED_CODES = {"osd", "equ", "snum"}
"""Tesseract models that are not languages."""

MODE_AUTO = "auto"
MODE_SKIP = "skip"
MODE_REDO = "redo"
MODE_FORCE = "force"


def tesseract_to_language(code: str) -> Optional[str]:
    """
    Map a Tesseract language model name to a normalized language code.

    Args:
        code: Tesseract model name such as "deu" or "chi_sim"

    Returns:
        The normalized code, or None for models that are not languages (scripts, vertical text, ...)
    """
    if code in TESSERACT_SPECIAL_CODES:
        return TESSERACT_SPECIAL_CODES[code]
    if code in TESSERACT_IGNORED_CODES or "/" in code or "_" in code:
        return None
    return normalize_ocr_language(code)


def language_to_tesseract(language: str, available: list[str]) -> Optional[str]:
    """
    Map a normalized language code to an installed Tesseract model.

    Args:
        language: Normalized language code such as "de" or "zh-Hans"
        available: Installed Tesseract model names

    Returns:
        The model name, or None if no installed model covers the language
    """
    normalized = normalize_ocr_language(language)
    if normalized is None:
        return None
    for code in available:
        if tesseract_to_language(code) == normalized:
            return code
    primary = normalized.split("-")[0]
    code = ISO639_1_TO_3.get(primary, primary)
    return code if code in available else None


class OcrmypdfEngine(OcrEngine):
    """OCR engine using OCRmyPDF and Tesseract."""

    id = "ocrmypdf"
    name = "OCRmyPDF (Tesseract)"
    description = "Open-source OCR with Tesseract, supports more than 100 languages."

    def __init__(self) -> None:
        self._tesseract_codes: Optional[list[str]] = None
        self._lock = threading.Lock()

    def get_options(self) -> dict[str, OcrOption]:
        return {
            "mode": {
                "type": "string",
                "label": "Mode",
                "description": "auto: chosen from the state of the text layer; skip: only pages without text; redo: replace an existing OCR layer, keep digital text; force: rasterize all pages and recognize them again (needed if digital text is garbled)",
                "options": [MODE_AUTO, MODE_SKIP, MODE_REDO, MODE_FORCE],
                "default": MODE_AUTO,
            },
            "deskew": {
                "type": "boolean",
                "label": "Straighten skewed pages",
                "description": "Rotates crooked scans by small angles before recognition. Not available in 'redo' mode.",
                "default": False,
            },
            "rotate_pages": {
                "type": "boolean",
                "label": "Fix page orientation",
                "description": "Turns pages that are upside down or sideways. Changes the page orientation, so coordinates of existing annotations may no longer match.",
                "default": False,
            },
        }

    def _get_tesseract_codes(self) -> list[str]:
        """Return the installed Tesseract language models, cached."""
        with self._lock:
            if self._tesseract_codes is None:
                try:
                    result = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, timeout=30, check=True)
                    lines = result.stdout.splitlines()
                    self._tesseract_codes = [line.strip() for line in lines[1:] if line.strip()]
                except (OSError, subprocess.SubprocessError) as e:
                    logger.warning(f"Could not list Tesseract languages: {e}")
                    return []
            return self._tesseract_codes

    def is_available(self) -> bool:
        if shutil.which("tesseract") is None:
            return False
        try:
            import ocrmypdf  # noqa: F401
        except ImportError:
            return False
        return bool(self._get_tesseract_codes())

    def get_languages(self) -> list[str]:
        languages = {tesseract_to_language(code) for code in self._get_tesseract_codes()}
        return sorted(lang for lang in languages if lang)

    def _choose_mode(self, input_path: Path) -> str:
        """Choose the OCRmyPDF mode from the state of the text layer."""
        try:
            report = analyze_text_layer(input_path)
        except Exception as e:
            logger.warning(f"Could not analyze text layer, forcing OCR: {e}")
            return MODE_FORCE
        if report.status == "missing":
            return MODE_SKIP
        if report.status == "good":
            return MODE_REDO if report.ocr_layer_pages else MODE_SKIP
        # Poor quality: an existing OCR layer without garbled characters can be redone,
        # anything else (broken font encodings, partly scanned pages) needs rasterizing
        if report.ocr_layer_pages and report.garbled_char_ratio == 0 and not report.image_only_pages:
            return MODE_REDO
        return MODE_FORCE

    def recognize(
        self,
        input_path: Path,
        output_path: Path,
        languages: list[str],
        options: dict[str, OcrOptionValue],
    ) -> Optional[str]:
        import ocrmypdf
        from ocrmypdf.exceptions import ExitCodeException

        available = self._get_tesseract_codes()
        tesseract_languages = []
        for language in languages:
            code = language_to_tesseract(language, available)
            if code is None:
                raise ValueError(f"Language '{language}' is not installed for Tesseract")
            tesseract_languages.append(code)

        mode = str(options.get("mode") or MODE_AUTO)
        if mode == MODE_AUTO:
            mode = self._choose_mode(input_path)
        deskew = bool(options.get("deskew", False))
        if deskew and mode == MODE_REDO:
            raise ValueError("Straightening skewed pages is not possible in 'redo' mode")

        logger.info(f"Running OCRmyPDF on {input_path.name} (mode={mode}, languages={tesseract_languages})")
        try:
            ocrmypdf.ocr(
                input_path,
                output_path,
                language=tesseract_languages,
                mode=mode,
                deskew=deskew,
                rotate_pages=bool(options.get("rotate_pages", False)),
                output_type="pdf",
                tagged_pdf_mode="ignore",
                invalidate_digital_signatures=True,
                progress_bar=False,
            )
        except ExitCodeException as e:
            raise RuntimeError(f"OCRmyPDF failed: {type(e).__name__}: {e}") from e
        return f"Text recognition finished (mode: {mode}, languages: {', '.join(tesseract_languages)})."
