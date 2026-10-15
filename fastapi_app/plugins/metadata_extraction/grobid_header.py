"""
Bibliographic metadata from the GROBID header extraction API.

Uses the server configured for the GROBID plugin (`/api/processHeaderDocument`). The plugin is
an optional dependency: all functions degrade to "not available" if it is not installed,
disabled, not configured or its server does not respond.
"""

import logging
import re
from typing import Optional

from lxml import etree

from fastapi_app.lib.services.metadata_extraction import Author, BibliographicMetadata

logger = logging.getLogger(__name__)

GROBID_PLUGIN_ID = "grobid"
HEADER_ENDPOINT = "/api/processHeaderDocument"

_NS = {"tei": "http://www.tei-c.org/ns/1.0"}


def get_live_grobid_server_url() -> Optional[str]:
    """
    Return the GROBID server URL if the GROBID plugin is active and its server is ready.

    Returns:
        The server URL, or None if the plugin is not active, no server is configured, or the
        server (or the Hugging Face Space hosting it) is not running
    """
    try:
        from fastapi_app.lib.plugins.plugin_manager import PluginManager

        if not PluginManager.get_instance().registry.is_active(GROBID_PLUGIN_ID):
            logger.debug("GROBID plugin is not active")
            return None

        from fastapi_app.lib.extraction import get_retry_session
        from fastapi_app.plugins.grobid.config import (
            get_grobid_hf_space,
            get_grobid_server_timeout,
            get_grobid_server_url,
        )
        from fastapi_app.plugins.grobid.hf_space import check_space_running
    except ImportError as e:
        logger.debug(f"GROBID plugin not available: {e}")
        return None

    server_url = get_grobid_server_url()
    if not server_url:
        logger.debug("No GROBID server configured")
        return None
    timeout = get_grobid_server_timeout()
    hf_error = check_space_running(server_url, timeout, get_grobid_hf_space())
    if hf_error:
        logger.info(f"GROBID server not available: {hf_error}")
        return None
    try:
        response = get_retry_session(retries=1, backoff_factor=0).get(f"{server_url}/api/health", timeout=timeout)
        ready = bool(response.json().get("ready", False))
    except Exception as e:
        logger.info(f"GROBID server not reachable: {e}")
        return None
    if not ready:
        logger.info("GROBID server is not ready")
        return None
    return server_url


def _text(element: Optional[etree._Element]) -> Optional[str]:  # type: ignore[name-defined]
    """Return the normalized text content of an element, or None if it is missing or empty."""
    if element is None:
        return None
    value = re.sub(r"\s+", " ", "".join(str(t) for t in element.itertext())).strip()
    return value or None


def _all(root: etree._Element, xpath: str) -> list[etree._Element]:  # type: ignore[name-defined]
    """Return the elements matching an XPath expression in the TEI namespace."""
    result = root.xpath(xpath, namespaces=_NS)
    return [e for e in result if isinstance(e, etree._Element)] if isinstance(result, list) else []


def _first(root: etree._Element, xpath: str) -> Optional[etree._Element]:  # type: ignore[name-defined]
    """Return the first element matching an XPath expression in the TEI namespace."""
    elements = _all(root, xpath)
    return elements[0] if elements else None


def parse_grobid_header(tei_xml: str | bytes) -> BibliographicMetadata:
    """
    Convert the TEI returned by GROBID's processHeaderDocument into bibliographic metadata.

    Args:
        tei_xml: TEI document as returned by GROBID

    Returns:
        Metadata dict; fields GROBID did not find are omitted
    """
    data = tei_xml.encode("utf-8") if isinstance(tei_xml, str) else tei_xml
    root = etree.fromstring(data, etree.XMLParser(recover=True))
    if root is None:
        return BibliographicMetadata()
    bibl = _first(root, "//tei:sourceDesc/tei:biblStruct")
    if bibl is None:
        bibl = root

    metadata = BibliographicMetadata()

    title = _text(_first(root, "//tei:titleStmt/tei:title[@level='a']")) or _text(
        _first(bibl, "tei:analytic/tei:title[@level='a']")
    )
    if title:
        metadata["title"] = title

    authors: list[Author] = []
    for pers_name in _all(bibl, "tei:analytic/tei:author/tei:persName"):
        given = " ".join(t for t in (_text(f) for f in _all(pers_name, "tei:forename")) if t)
        family = _text(_first(pers_name, "tei:surname")) or ""
        if given or family:
            authors.append(Author(given=given, family=family))
    if authors:
        metadata["authors"] = authors

    journal = _text(_first(bibl, "tei:monogr/tei:title[@level='j']"))
    if journal:
        metadata["journal"] = journal

    date_elem = _first(bibl, "tei:monogr/tei:imprint/tei:date")
    if date_elem is None:
        date_elem = _first(root, "//tei:publicationStmt/tei:date")
    if date_elem is not None:
        date = date_elem.get("when") or _text(date_elem)
        if date:
            metadata["date"] = date

    publisher = _text(_first(bibl, "tei:monogr/tei:imprint/tei:publisher")) or _text(
        _first(root, "//tei:publicationStmt/tei:publisher")
    )
    if publisher:
        metadata["publisher"] = publisher

    volume = _text(_first(bibl, "tei:monogr/tei:imprint/tei:biblScope[@unit='volume']"))
    if volume:
        metadata["volume"] = volume
    issue = _text(_first(bibl, "tei:monogr/tei:imprint/tei:biblScope[@unit='issue']"))
    if issue:
        metadata["issue"] = issue

    page_elem = _first(bibl, "tei:monogr/tei:imprint/tei:biblScope[@unit='page']")
    if page_elem is not None:
        start, end = page_elem.get("from"), page_elem.get("to")
        pages = f"{start}-{end}" if start and end else (_text(page_elem) or start)
        if pages:
            metadata["pages"] = pages

    doi = _text(_first(bibl, ".//tei:idno[@type='DOI']"))
    if doi:
        metadata["doi"] = doi
    issn = _text(_first(bibl, ".//tei:idno[@type='ISSN']"))
    if issn:
        metadata["issn"] = issn
    isbn = _text(_first(bibl, ".//tei:idno[@type='ISBN']"))
    if isbn:
        metadata["isbn"] = isbn

    return metadata


def fetch_grobid_header_metadata(pdf_path: str, server_url: str) -> BibliographicMetadata:
    """
    Extract header metadata from a PDF with GROBID (blocking).

    Header consolidation is disabled, so the result only contains what GROBID reads from the PDF.

    Args:
        pdf_path: Path to the PDF file
        server_url: GROBID server URL, see `get_live_grobid_server_url()`

    Returns:
        Metadata dict; fields GROBID did not find are omitted

    Raises:
        RuntimeError: If the request fails
    """
    from fastapi_app.lib.extraction import get_retry_session
    from fastapi_app.plugins.grobid.config import get_grobid_extraction_timeout

    session = get_retry_session(retries=2, backoff_factor=2.0)
    try:
        with open(pdf_path, "rb") as pdf_file:
            response = session.post(
                f"{server_url}{HEADER_ENDPOINT}",
                files={"input": pdf_file},
                data={"consolidateHeader": "0", "includeRawAffiliations": "0"},
                headers={"Accept": "application/xml"},
                timeout=get_grobid_extraction_timeout(),
            )
        response.raise_for_status()
    except Exception as e:
        raise RuntimeError(f"GROBID header extraction failed: {e}") from e
    return parse_grobid_header(response.content)
