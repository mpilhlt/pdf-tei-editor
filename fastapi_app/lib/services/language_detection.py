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

from fastapi_app.lib.utils.tei_utils import (
    get_document_language,
    serialize_tei_like_source,
    set_document_language,
)

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


LANGUAGE_FROM_DECLARATION = "lang-usage"
LANGUAGE_FROM_PDF_TEXT = "pdf-text"
LANGUAGE_FROM_TEI_TEXT = "tei-text"
LANGUAGE_FROM_REGISTRY = "registry"
LANGUAGE_FROM_XML_LANG = "xml-lang"
"""Sources of a predicted language, see `predict_document_language_with_source()`."""


def predict_document_language_with_source(
    tei_root: etree._Element,  # type: ignore[name-defined]
    pdf_path: Optional[str] = None,
    pdf_text: Optional[str] = None,
    registry_language: Optional[str] = None,
) -> tuple[Optional[str], Optional[str]]:
    """
    Predict the language of a TEI document and report where the prediction comes from.

    Lookup order:

    1. profileDesc/langUsage/language/@ident, ignoring "und"
    2. detection from the PDF text layer
    3. detection from the TEI text content
    4. the registry language (CrossRef/DataCite), if given
    5. TEI/@xml:lang or text/@xml:lang

    Text detection takes precedence over xml:lang because GROBID declares text/@xml:lang="en"
    for documents in other languages.

    Args:
        tei_root: TEI root element
        pdf_path: Optional path to the source PDF, used as primary text source for detection
        pdf_text: Optional pre-extracted PDF text; takes precedence over `pdf_path` so that callers
            processing several TEI files of the same PDF extract its text only once
        registry_language: Optional normalized language from bibliographic registry metadata

    Returns:
        Tuple of (BCP 47 language tag, LANGUAGE_FROM_* source), or (None, None)
    """
    ident = tei_root.xpath(
        "string(tei:teiHeader/tei:profileDesc/tei:langUsage/tei:language/@ident)",
        namespaces={"tei": "http://www.tei-c.org/ns/1.0"},
    )
    if ident and ident != UNDETERMINED_LANGUAGE:
        return str(ident), LANGUAGE_FROM_DECLARATION
    if pdf_text is None and pdf_path:
        pdf_text = extract_pdf_text(pdf_path)
    language = detect_language(pdf_text) if pdf_text else None
    if language:
        return language, LANGUAGE_FROM_PDF_TEXT
    language = detect_language(get_tei_text_content(tei_root))
    if language:
        return language, LANGUAGE_FROM_TEI_TEXT
    if registry_language:
        return registry_language, LANGUAGE_FROM_REGISTRY
    language = get_document_language(tei_root)
    if language and language != UNDETERMINED_LANGUAGE:
        return language, LANGUAGE_FROM_XML_LANG
    return None, None


def predict_document_language(
    tei_root: etree._Element,  # type: ignore[name-defined]
    pdf_path: Optional[str] = None,
    pdf_text: Optional[str] = None,
) -> Optional[str]:
    """
    Predict the language of a TEI document, see `predict_document_language_with_source()`.

    Returns:
        BCP 47 language tag, or None if no language is declared and none can be detected
    """
    return predict_document_language_with_source(tei_root, pdf_path, pdf_text)[0]


def add_document_language(tei_xml: str, pdf_path: Optional[str] = None) -> str:
    """
    Make sure a TEI document declares its language in teiHeader/profileDesc/langUsage.

    The language is detected from the PDF text layer, then from the TEI text content. Only if
    the text is too short for detection, a language declared by the extractor via TEI/@xml:lang
    or text/@xml:lang is used (GROBID declares "en" regardless of the language). If no language
    can be determined, "und" (undetermined) is declared.

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

    language = predict_document_language(root, pdf_path) or UNDETERMINED_LANGUAGE

    if not set_document_language(root, language):
        return tei_xml
    logger.debug(f"Declared document language: {language}")

    return serialize_tei_like_source(root, tei_xml)
