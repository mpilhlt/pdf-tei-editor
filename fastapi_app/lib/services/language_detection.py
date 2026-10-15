"""
Language detection for extracted documents.

Uses py3langid (a compact n-gram model, numpy-based) to identify the language of
a text sample. The model is loaded lazily on first use and cached.
"""

import logging
import re
import threading
from typing import Optional

from lxml import etree
from py3langid.langid import LanguageIdentifier, MODEL_FILE

from fastapi_app.lib.utils.tei_utils import get_document_language, set_document_language

logger = logging.getLogger(__name__)

UNDETERMINED_LANGUAGE = "und"
"""BCP 47 code for 'undetermined', used when no language can be detected."""

MIN_TEXT_LENGTH = 100
"""Minimum number of letter characters needed for a reliable detection."""

MAX_TEXT_LENGTH = 20000
"""Maximum number of characters fed to the classifier."""

MIN_CONFIDENCE = 0.5
"""Minimum normalized probability for a detection to be accepted."""

_identifier: Optional[LanguageIdentifier] = None
_identifier_lock = threading.Lock()


def _get_identifier() -> LanguageIdentifier:
    """Return the cached language identifier, loading the model on first use."""
    global _identifier
    with _identifier_lock:
        if _identifier is None:
            _identifier = LanguageIdentifier.from_model_file(MODEL_FILE, norm_probs=True)
        return _identifier


def detect_language(text: str) -> Optional[str]:
    """
    Detect the language of a text sample.

    Args:
        text: Text to classify

    Returns:
        ISO 639-1 language code (valid BCP 47 tag), or None if the text is too short or
        the classifier is not confident enough
    """
    if not text:
        return None
    sample = re.sub(r"\s+", " ", text).strip()[:MAX_TEXT_LENGTH]
    if sum(1 for c in sample if c.isalpha()) < MIN_TEXT_LENGTH:
        return None
    try:
        lang, confidence = _get_identifier().classify(sample)
    except Exception as e:
        logger.warning(f"Language detection failed: {e}")
        return None
    if confidence < MIN_CONFIDENCE:
        logger.debug(f"Language detection not confident enough: {lang} ({confidence:.2f})")
        return None
    return str(lang)


def extract_pdf_text(pdf_path: str, max_pages: int = 5) -> str:
    """
    Extract the text layer of the first pages of a PDF.

    Args:
        pdf_path: Path to the PDF file
        max_pages: Number of leading pages to read

    Returns:
        Extracted text, or an empty string if the PDF has no text layer or cannot be read
    """
    try:
        from pypdf import PdfReader

        reader = PdfReader(pdf_path)
        return "\n".join((page.extract_text() or "") for page in reader.pages[:max_pages])
    except Exception as e:
        logger.warning(f"Could not extract text from PDF {pdf_path}: {e}")
        return ""


def get_tei_text_content(tei_root: etree._Element) -> str:  # type: ignore[name-defined]
    """
    Return the text content of the TEI document's text elements (excluding the header).

    Args:
        tei_root: TEI root element

    Returns:
        Concatenated text content
    """
    texts = tei_root.xpath("//tei:text//text()", namespaces={"tei": "http://www.tei-c.org/ns/1.0"})
    return " ".join(str(t) for t in texts) if isinstance(texts, list) else ""


def add_document_language(tei_xml: str, pdf_path: Optional[str] = None) -> str:
    """
    Make sure a TEI document declares its language in teiHeader/profileDesc/langUsage.

    A language already declared by the extractor (langUsage, TEI/@xml:lang or text/@xml:lang)
    is kept. Otherwise it is detected from the PDF text layer, then from the TEI text content.
    If no language can be detected, "und" (undetermined) is declared.

    The document is returned unchanged if it already has a langUsage/language declaration,
    has no teiHeader, or cannot be parsed. Formatting outside the inserted element is preserved.

    Args:
        tei_xml: TEI document as string
        pdf_path: Optional path to the source PDF, used as primary text source for detection

    Returns:
        The TEI document with the language declaration
    """
    try:
        root = etree.fromstring(tei_xml.encode("utf-8"))
    except etree.XMLSyntaxError as e:
        logger.warning(f"Cannot add document language, TEI is not well-formed: {e}")
        return tei_xml
    ns = {"tei": "http://www.tei-c.org/ns/1.0"}
    if root.find("tei:teiHeader/tei:profileDesc/tei:langUsage/tei:language", namespaces=ns) is not None:
        return tei_xml

    language = get_document_language(root)
    if not language and pdf_path:
        language = detect_language(extract_pdf_text(pdf_path))
    if not language:
        language = detect_language(get_tei_text_content(root))
    language = language or UNDETERMINED_LANGUAGE

    if not set_document_language(root, language):
        return tei_xml
    logger.debug(f"Declared document language: {language}")

    # Serialize prolog/epilog nodes (processing instructions, comments) one per line, as lxml
    # would otherwise join them to the root element
    parts = [etree.tostring(n, encoding="unicode", with_tail=False) for n in reversed(list(root.itersiblings(preceding=True)))]
    parts.append(etree.tostring(root, encoding="unicode", with_tail=False))
    parts.extend(etree.tostring(n, encoding="unicode", with_tail=False) for n in root.itersiblings())
    if tei_xml.lstrip().startswith("<?xml "):
        parts.insert(0, '<?xml version="1.0" encoding="UTF-8"?>')
    return "\n".join(parts) + ("\n" if tei_xml.endswith("\n") else "")
