"""
OCR engine based on OCRmyPDF, which runs Tesseract and writes the recognized
text as an invisible layer on top of the page images, without changing the page
geometry.

A digital text layer that is broken (wrong characters or positions) is replaced
in two steps:

1. vectorize: Ghostscript converts the text to outlines, which keeps the page
   appearance but removes the text, and OCRmyPDF adds a new text layer
   (see vectorize.py)
2. force: if step 1 is not possible or its result fails the checks, OCRmyPDF
   rasterizes the pages and recognizes them

Requires the `tesseract` binary with the language data packages
(`tesseract-ocr-<lang>` on Debian). Step 1 also requires the `gs` binary
(Ghostscript); without it, only step 2 is used.

The Debian packages contain the `tessdata_fast` models. Models from `tessdata_best`
(more accurate, slower) are found in the subdirectory `best/` of the tessdata
directory, where Tesseract lists them as `best/<lang>`; the option `model` selects them.
The plugin downloads them into the shared data directory and links them (see tessdata.py).
"""

import csv
import logging
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional

import pikepdf

from fastapi_app.lib.models.models_ocr import TextQualityReport
from fastapi_app.lib.ocr.base import OcrEngine, OcrMethod, OcrOption, OcrOptionValue, OcrResult, OcrWord
from fastapi_app.lib.ocr.languages import ISO639_1_TO_3, normalize_ocr_language
from fastapi_app.lib.ocr.progress import report_progress
from fastapi_app.lib.ocr.text_quality import analyze_text_layer

from . import vectorize
from .run_log import ocr_run_log, run_log_path

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
MODE_VECTORIZE = "vectorize"

MODEL_FAST = "fast"
MODEL_BEST = "best"
BEST_MODEL_PREFIX = "best/"
"""Tesseract names the models in the `best/` subdirectory of the tessdata directory `best/<lang>`."""

METHODS: dict[str, OcrMethod] = {MODE_SKIP: "skip", MODE_REDO: "redo", MODE_FORCE: "force", MODE_VECTORIZE: "vectorize"}
"""The method reported for each mode."""

TESSERACT_WORDS_TIMEOUT = 120
"""Timeout in seconds for recognizing the words of one page image."""


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
        options: dict[str, OcrOption] = {
            "mode": {
                "type": "string",
                "label": "Mode",
                "description": "auto: chosen from the state of the text layer; skip: only pages without text; redo: replace an existing OCR layer, keep digital text; vectorize: replace a broken digital text layer and keep the pages as vector graphics (rasterizes if that is not possible); force: rasterize all pages and recognize them again",
                "options": [MODE_AUTO, MODE_SKIP, MODE_REDO, MODE_VECTORIZE, MODE_FORCE],
                "default": MODE_AUTO,
            },
            "rasterize_fallback": {
                "type": "boolean",
                "label": "Rasterize if needed",
                "description": "If the text of a digital PDF cannot be converted to outlines, convert the pages to images instead. The stored PDF is replaced, so the pages then lose their vector graphics. If unchecked, the text recognition fails instead.",
                "default": True,
            },
            "deskew": {
                "type": "boolean",
                "label": "Straighten skewed pages",
                "description": "Rotates crooked scans by small angles before recognition. Not available in 'redo' mode, and not applied when the pages are kept as vector graphics.",
                "default": False,
            },
            "repair_footnote_markers": {
                "type": "boolean",
                "label": "Repair footnote markers",
                "description": "Reads superscript footnote markers that Tesseract misrecognized as punctuation again and corrects them where the number fits the footnote numbering of the document.",
                "default": True,
            },
            "optimize_images": {
                "type": "boolean",
                "label": "Optimize images",
                "description": "Recompresses the page images of the result losslessly, which makes the file smaller and the recognition take longer. Does not change the text.",
                "default": True,
            },
            "rotate_pages": {
                "type": "boolean",
                "label": "Fix page orientation",
                "description": "Turns pages that are upside down or sideways. Changes the page orientation, so coordinates of existing annotations may no longer match.",
                "default": False,
            },
        }
        if self._best_models_installed():
            options["model"] = {
                "type": "string",
                "label": "Recognition model",
                "description": "fast: the standard Tesseract models; best: the more accurate tessdata_best models, which take several times as long. Languages without a best model use the fast one.",
                "options": [MODEL_FAST, MODEL_BEST],
                "default": MODEL_FAST,
            }
        return options

    def invalidate_models(self) -> None:
        """Forget the cached list of installed models, e.g. after a model was downloaded."""
        with self._lock:
            self._tesseract_codes = None

    def _best_models_installed(self) -> bool:
        """Return whether any tessdata_best model is installed."""
        return any(code.startswith(BEST_MODEL_PREFIX) for code in self._get_tesseract_codes())

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

    def _tesseract_languages(self, languages: list[str], model: str = MODEL_FAST) -> list[str]:
        """
        Map normalized language codes to installed Tesseract models.

        Args:
            languages: Normalized language codes
            model: MODEL_FAST or MODEL_BEST. With MODEL_BEST, the tessdata_best model is used
                where one is installed, the fast model otherwise.

        Raises:
            ValueError: If a language is not installed
        """
        available = self._get_tesseract_codes()
        codes: list[str] = []
        for language in languages:
            code = language_to_tesseract(language, available)
            if code is None:
                raise ValueError(f"Language '{language}' is not installed for Tesseract")
            if model == MODEL_BEST and BEST_MODEL_PREFIX + code in available:
                code = BEST_MODEL_PREFIX + code
            codes.append(code)
        return codes

    def supports_word_recognition(self) -> bool:
        return True

    def recognize_words(self, image_path: Path, languages: list[str]) -> list[OcrWord]:
        command = ["tesseract", str(image_path), "stdout", "-l", "+".join(self._tesseract_languages(languages)), "tsv"]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=TESSERACT_WORDS_TIMEOUT, check=True)
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"Tesseract failed: {e.stderr.strip() or e.returncode}") from e
        return parse_tesseract_tsv(result.stdout)

    @staticmethod
    def choose_mode(report: Optional[TextQualityReport], rebuild: bool) -> str:
        """
        Choose the method from the state of the text layer.

        Args:
            report: The text quality report, None if the analysis failed
            rebuild: Whether the user explicitly asked to recreate the text layer

        Returns:
            One of the MODE_* constants except MODE_AUTO
        """
        if report is None:
            return MODE_VECTORIZE
        if report.status == "missing":
            return MODE_SKIP
        only_ocr_text = report.ocr_layer_pages > 0 and not report.image_only_pages
        if report.status == "good":
            if report.ocr_layer_pages:
                return MODE_REDO
            return MODE_VECTORIZE if rebuild else MODE_SKIP
        # Poor quality: an existing OCR layer without garbled characters can be redone, anything
        # else (broken font encodings, misplaced text, partly scanned pages) needs a new text layer
        if only_ocr_text and report.garbled_char_ratio == 0:
            return MODE_REDO
        return MODE_VECTORIZE

    def recognize(
        self,
        input_path: Path,
        output_path: Path,
        languages: list[str],
        options: dict[str, OcrOptionValue],
        rebuild: bool = False,
    ) -> OcrResult:
        """
        Apply OCR (see OcrEngine.recognize()).

        The details of the run are written to the run log (see run_log.py), the application
        log only gets a summary.
        """
        started = time.monotonic()
        with ocr_run_log(_run_log_file()) as log_file:
            details = f"; details in {log_file}" if log_file else ""
            logger.info(f"Text recognition of {input_path.name} started (languages: {', '.join(languages)}, options: {options}){details}")
            try:
                result = self._recognize(input_path, output_path, languages, options, rebuild)
            except Exception as e:
                logger.info(f"Text recognition of {input_path.name} failed after {time.monotonic() - started:.0f} s: {e}{details}")
                raise
            logger.info(f"Text recognition of {input_path.name} finished in {time.monotonic() - started:.0f} s: {result.message}")
            return result

    def _recognize(
        self,
        input_path: Path,
        output_path: Path,
        languages: list[str],
        options: dict[str, OcrOptionValue],
        rebuild: bool,
    ) -> OcrResult:
        tesseract_languages = self._tesseract_languages(languages, str(options.get("model") or MODEL_FAST))
        mode = str(options.get("mode") or MODE_AUTO)
        if mode == MODE_AUTO:
            report_progress("Analyzing the text layer")
            try:
                report: Optional[TextQualityReport] = analyze_text_layer(input_path)
            except Exception as e:
                logger.warning(f"Could not analyze the text layer: {e}")
                report = None
            mode = self.choose_mode(report, rebuild)
        deskew = bool(options.get("deskew", False))
        if deskew and mode == MODE_REDO:
            raise ValueError("Straightening skewed pages is not possible in 'redo' mode")

        with tempfile.TemporaryDirectory(prefix="pte-ocrmypdf-") as tmp:
            tmp_dir = Path(tmp)
            source = self._decrypt(input_path, tmp_dir)
            if mode != MODE_VECTORIZE:
                repaired = self._run_ocrmypdf(source, output_path, tesseract_languages, mode, deskew, options)
                return OcrResult(message=self._message(mode, tesseract_languages, repaired, options), method=METHODS[mode], models=tesseract_languages)

            reason = self._vectorize(input_path, source, tmp_dir)
            if reason is None:
                repaired = self._run_ocrmypdf(tmp_dir / "outlined.pdf", output_path, tesseract_languages, MODE_SKIP, False, options)
                message = self._message(MODE_VECTORIZE, tesseract_languages, repaired, options)
                if deskew:
                    message += " Skewed pages were not straightened, since the pages were kept as vector graphics."
                return OcrResult(message=message, method="vectorize", models=tesseract_languages)

            if not options.get("rasterize_fallback", True):
                raise ValueError(f"The text layer could not be replaced without rasterizing the pages: {reason}.")
            logger.info(f"Rasterizing {input_path.name} instead of converting the text to outlines: {reason}")
            repaired = self._run_ocrmypdf(source, output_path, tesseract_languages, MODE_FORCE, deskew, options)
            message = self._message(MODE_FORCE, tesseract_languages, repaired, options) + f" The pages were converted to images, since {reason}."
            return OcrResult(message=message, method="force", fallback_reason=reason, models=tesseract_languages)

    @staticmethod
    def _message(mode: str, tesseract_languages: list[str], repaired_markers: int = 0, options: Optional[dict[str, OcrOptionValue]] = None) -> str:
        """Return the message reporting a finished run, naming the post-processing steps turned off in `options`."""
        options = options or {}
        descriptions: dict[str, str] = {
            MODE_SKIP: "pages without text were recognized",
            MODE_REDO: "the existing OCR layer was replaced",
            MODE_FORCE: "all pages were rasterized and recognized",
            MODE_VECTORIZE: "the text layer was replaced, the pages were kept as vector graphics",
        }
        message = f"Text recognition finished: {descriptions.get(mode, mode)} (models: {', '.join(tesseract_languages)})."
        if repaired_markers:
            message += f" {repaired_markers} misrecognized footnote markers were corrected."
        skipped = [step for step, key in (("footnote marker repair", "repair_footnote_markers"), ("image optimization", "optimize_images")) if options.get(key) is False]
        if skipped:
            message += f" Skipped: {', '.join(skipped)}."
        return message

    @staticmethod
    def _decrypt(input_path: Path, tmp_dir: Path) -> Path:
        """
        Return a decrypted copy of an encrypted PDF that opens without a password, or the input.

        OCRmyPDF does not process encrypted PDFs.

        Raises:
            ValueError: If the PDF needs a password
        """
        try:
            with pikepdf.open(input_path) as pdf:
                if not pdf.is_encrypted:
                    return input_path
                decrypted = tmp_dir / "decrypted.pdf"
                pdf.save(decrypted)
                return decrypted
        except pikepdf.PasswordError:
            raise ValueError("The PDF is protected by a password")

    @staticmethod
    def _vectorize(input_path: Path, source: Path, tmp_dir: Path) -> Optional[str]:
        """
        Convert the text of a PDF to outlines, writing tmp_dir/outlined.pdf.

        Args:
            input_path: The PDF as stored
            source: The PDF to convert (a decrypted copy if input_path is encrypted)
            tmp_dir: Directory for intermediate files

        Returns:
            None on success, otherwise the reason why the result cannot be used
        """
        if not vectorize.ghostscript_available():
            return "Ghostscript is not installed"
        if source != input_path:
            return "the PDF is encrypted"
        report_progress("Converting the text to outlines")
        try:
            with pikepdf.open(source) as pdf:
                page_count = len(pdf.pages)
            vectorize.outline_text(source, tmp_dir / "gs.pdf", page_count)
            shapes = vectorize.compact_glyph_paths(tmp_dir / "gs.pdf", tmp_dir / "outlined.pdf")
            logger.debug(f"Converted the text of {input_path.name} to outlines ({shapes} distinct shapes)")
            report_progress("Checking the converted pages")
            return vectorize.verify_outlined(source, tmp_dir / "outlined.pdf")
        except Exception as e:
            logger.warning(f"Could not convert the text of {input_path.name} to outlines: {e}")
            return f"converting the text to outlines failed ({e})"

    @staticmethod
    def _run_ocrmypdf(
        input_path: Path,
        output_path: Path,
        tesseract_languages: list[str],
        mode: str,
        deskew: bool,
        options: dict[str, OcrOptionValue],
    ) -> int:
        """
        Run OCRmyPDF, with the plugin that repairs misrecognized footnote markers (#904).

        The plugin is always loaded: OCRmyPDF serializes jobs with different plugin sets, so the
        option `repair_footnote_markers` turns the repair off through an argument the plugin
        reads (`ocrmypdf_plugin.REPAIR_OPTION`). `optimize_images` chooses OCRmyPDF's
        optimization level 1 (lossless, OCRmyPDF's default) or 0 (none).

        Returns:
            The number of repaired footnote markers

        Raises:
            RuntimeError: If OCRmyPDF fails
        """
        import ocrmypdf
        from ocrmypdf.exceptions import ExitCodeException

        from . import ocrmypdf_plugin

        logger.debug(f"Running OCRmyPDF on {input_path.name} (mode={mode}, languages={tesseract_languages})")
        ocrmypdf_plugin.reset_repair_count()
        try:
            ocrmypdf.ocr(
                input_path,
                output_path,
                language=tesseract_languages,
                mode=mode,
                deskew=deskew,
                rotate_pages=bool(options.get("rotate_pages", False)),
                optimize=1 if options.get("optimize_images", True) is not False else 0,
                output_type="pdf",
                tagged_pdf_mode="ignore",
                invalidate_digital_signatures=True,
                progress_bar=False,
                plugins=[ocrmypdf_plugin.__name__],
                # ocrmypdf_plugin.REPAIR_OPTION
                pte_repair_footnote_markers=options.get("repair_footnote_markers", True) is not False,
            )
        except ExitCodeException as e:
            raise RuntimeError(f"OCRmyPDF failed: {type(e).__name__}: {e}") from e
        return ocrmypdf_plugin.repair_count()


def _run_log_file() -> Optional[Path]:
    """Return the path of the run log in the application's log directory, None if unknown."""
    try:
        from fastapi_app.config import get_settings

        return run_log_path(get_settings().log_dir)
    except Exception as e:
        logger.debug(f"No log directory for the OCR run log: {e}")
        return None


def parse_tesseract_tsv(tsv: str) -> list[OcrWord]:
    """
    Parse the TSV output of Tesseract into words with relative coordinates.

    Args:
        tsv: Output of `tesseract <image> stdout tsv`

    Returns:
        The words in reading order
    """
    rows = list(csv.DictReader(tsv.splitlines(), delimiter="\t", quoting=csv.QUOTE_NONE))
    page = next((row for row in rows if row.get("level") == "1"), None)
    if page is None:
        return []
    width, height = float(page["width"]), float(page["height"])
    if width <= 0 or height <= 0:
        return []
    words: list[OcrWord] = []
    for row in rows:
        text = (row.get("text") or "").strip()
        if row.get("level") != "5" or not text:
            continue
        left, top = float(row["left"]), float(row["top"])
        words.append(OcrWord(
            text=text,
            left=left / width,
            top=top / height,
            right=(left + float(row["width"])) / width,
            bottom=(top + float(row["height"])) / height,
            confidence=max(0.0, float(row["conf"])) / 100,
        ))
    return words
