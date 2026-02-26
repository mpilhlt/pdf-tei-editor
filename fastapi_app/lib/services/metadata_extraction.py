"""
Bibliographic metadata extraction utilities for retrieving document metadata.

Provides:
- Metadata extraction from PDFs via extraction service
- LLM-based metadata parsing with JSON schema validation
- Fallback mechanisms for when DOI lookup fails
"""

import logging
from typing import Dict, Any, TypedDict, List, Optional, Union

logger = logging.getLogger(__name__)


class Author(TypedDict):
    """Author information with given and family names."""
    given: str
    family: str


class BibliographicMetadata(TypedDict, total=False):
    """
    Bibliographic metadata extracted from documents.

    This type represents the standardized structure for bibliographic metadata
    that can be obtained from DOI lookup or LLM extraction services.
    """
    title: Optional[str]
    authors: List[Author]
    date: Optional[Union[str, int]]
    publisher: Optional[str]
    journal: Optional[str]
    volume: Optional[str]
    issue: Optional[str]
    pages: Optional[str]
    doi: Optional[str]
    issn: Optional[str]
    isbn: Optional[str]
    id: Optional[str]
    url: Optional[str]
    # Additional fields for document ID resolution
    doc_id: Optional[str]
    doc_id_type: Optional[str]
    fileref: Optional[str]

# JSON schema for bibliographic metadata extraction via LLM
BIBLIOGRAPHIC_METADATA_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "The title of the document"},
        "authors": {
            "type": "array",
            "description": "List of authors",
            "items": {
                "type": "object",
                "properties": {
                    "given": {"type": "string", "description": "Given/first name"},
                    "family": {"type": "string", "description": "Family/last name"}
                }
            }
        },
        "date": {
            "type": ["string", "integer"],
            "description": "Publication year"
        },
        "publisher": {"type": "string", "description": "Publisher name"},
        "journal": {"type": "string", "description": "Journal or container title"},
        "volume": {"type": "string", "description": "Volume number"},
        "issue": {"type": "string", "description": "Issue number"},
        "pages": {"type": "string", "description": "Page range (e.g., '1-15')"},
        "issn": {"type": "string", "description": "ISSN (International Standard Serial Number) for journals"},
        "isbn": {"type": "string", "description": "ISBN (International Standard Book Number) for books"},
        "id": {"type": "string", "description": "Any type of persisten identifier, preferrably DOI"},
        "url": {"type": "string", "description": "A stable or persistent URL for accessing the document, if present in the document"}
    }
}

BIBLIOGRAPHIC_METADATA_PROMPT = """
Extract bibliographic metadata from this document.

Extract the following information if available:
- title: The main title of the document
- authors: List of authors with given (first) and family (last) names
- date: Publication year
- publisher: Publisher name, if a book
- journal: Journal or book title if this is an article or chapter
- volume: Volume number
- issue: Issue number
- pages: Page range
- issn: ISSN (International Standard Serial Number) for journals, if present
- isbn: ISBN (International Standard Book Number) for books, if present
- id: any kind of persistent identifier like DOI, ISBN, JSTOR, ARXIV, etc. if present.
  Prefix with the type of identifier in lowercase like so: "doi:10.1234/example.2024" or
  "isbn:978-0-123456-78-9" or "jstor:44290231".
  ONLY return a DOI if you can read one verbatim in the document. Do NOT guess or fabricate a DOI.
- url: A stable or persistent URL for accessing the document, if one is visible in the document.
  Only return a URL you can read verbatim. Do NOT guess or fabricate a URL.

Critical rules:
- Return the information as JSON matching the expected schema.
- Only include fields where you can find the information.
- If author names or the title are in all-caps, return them properly capitalized
"""


def _normalize_extracted_metadata(data: Dict[str, Any]) -> BibliographicMetadata:
    """
    Normalize metadata extracted by LLM to match fetch_doi_metadata() format.

    Args:
        data: Raw extracted data from LLM

    Returns:
        Normalized metadata dict
    """
    # Ensure authors is a list of dicts with 'given' and 'family' keys
    authors = data.get("authors", [])
    if authors and isinstance(authors[0], str):
        # Convert string authors to dict format
        normalized_authors = []
        for author in authors:
            parts = author.rsplit(" ", 1)
            if len(parts) == 2:
                normalized_authors.append({"given": parts[0], "family": parts[1]})
            else:
                normalized_authors.append({"given": "", "family": author})
        authors = normalized_authors
    
    # DOI normalization: only promote to 'doi' if the value actually validates as a DOI
    if 'id' in data and 'doi:' in data.get('id', ''):
        from fastapi_app.lib.utils.doi_utils import validate_doi
        candidate_doi = data['id'].replace('doi:', '')
        if validate_doi(candidate_doi):
            data['doi'] = candidate_doi
        else:
            # Not a real DOI — drop the invalid doi: prefix so it isn't misused downstream
            logger.warning(f"LLM returned invalid DOI, dropping: {data['id']}")
            data['id'] = None

    return BibliographicMetadata({
        "title": data.get("title"),
        "authors": authors,
        "date": data.get("date"),
        "publisher": data.get("publisher"),
        "journal": data.get("journal"),
        "volume": data.get("volume"),
        "issue": data.get("issue"),
        "pages": data.get("pages"),
        "doi": data.get("doi"),
        "issn": data.get("issn"),
        "isbn": data.get("isbn"),
        "id": data.get("id"),
        "url": data.get("url")
    })


async def get_metadata_for_document(
    doi: str | None = None,
    pdf_path: str | None = None,
    text_content: str | None = None,
    stable_id: str | None = None,
    use_extraction: bool = True,
) -> BibliographicMetadata:
    """
    Get bibliographic metadata, trying DOI lookup first, then extraction service.

    This function provides a unified way to obtain document metadata:
    1. If a DOI is provided, attempts to fetch from CrossRef/DataCite
    2. If DOI lookup fails or no DOI provided, falls back to LLM extraction service
    3. Returns empty dict if all methods fail

    Args:
        doi: DOI string (optional) - will be validated and looked up
        pdf_path: Path to PDF file (optional) - kept for signature compatibility
        text_content: Text content (optional) - used for LLM extraction fallback
        stable_id: File stable_id (optional) - used for PDF lookup via extraction service
        use_extraction: If False, skip LLM extraction fallback (only use DOI lookup).
                        Defaults to True for backward compatibility.

    Returns:
        Metadata dict with keys: title, authors, date, publisher, journal, etc.
        Returns empty dict if no metadata could be obtained.

    Examples:
        >>> # With DOI
        >>> metadata = await get_metadata_for_document(doi="10.1234/example")
        >>> metadata['title']
        "Example Article"

        >>> # Without DOI, using stable_id for PDF extraction
        >>> metadata = await get_metadata_for_document(stable_id="abc123")
    """
    # Runtime validation for backward compatibility
    # Ensure all required fields are present even if not provided by source
    def validate_metadata(metadata: BibliographicMetadata) -> BibliographicMetadata:
        """Ensure metadata has all required structure for backward compatibility."""
        # Ensure authors is always a list
        if 'authors' not in metadata or metadata['authors'] is None:
            metadata['authors'] = []
        
        # Ensure other optional fields have proper types
        for field in ['title', 'date', 'publisher', 'journal', 'volume', 'issue', 'pages', 'doi', 'id', 'url']:
            if field not in metadata:
                metadata[field] = None
        
        return metadata

    # 1. Try DOI lookup first if DOI provided
    if doi:
        from fastapi_app.lib.utils.doi_utils import normalize_doi, validate_doi, fetch_doi_metadata
        
        doi = normalize_doi(doi)
        if validate_doi(doi):
            try:
                logger.debug(f"Attempting DOI metadata lookup for: {doi}")
                result = fetch_doi_metadata(doi)
                return validate_metadata(result)
            except Exception as e:
                logger.warning(f"DOI lookup failed for {doi}: {e}")
        else:
            logger.warning(f"Invalid DOI format, skipping lookup: {doi}")

    # 2. Fallback to extraction service if enabled and stable_id or text_content is available
    if use_extraction and (stable_id or text_content):
        try:
            from fastapi_app.lib.service_registry import get_service_registry

            service = get_service_registry().get_extraction_service()

            if service:
                logger.debug("Attempting metadata extraction via service")

                result = await service.extract(
                    prompt=BIBLIOGRAPHIC_METADATA_PROMPT,
                    stable_id=stable_id,
                    text_input=text_content,
                    model_capabilities={"input": ["image"]} if stable_id else None,
                    json_schema=BIBLIOGRAPHIC_METADATA_SCHEMA,
                    temperature=0.1,
                    max_retries=2
                )

                if result.get("success"):
                    logger.debug("Metadata extraction via service succeeded")
                    normalized = _normalize_extracted_metadata(result.get("data", {}))
                    return validate_metadata(normalized)
                else:
                    logger.warning(f"Metadata extraction failed: {result.get('error')}")

        except ImportError:
            logger.debug("Service registry not available, skipping extraction fallback")
        except Exception as e:
            logger.warning(f"Extraction service fallback failed: {e}")

    # 3. Return empty metadata if all methods fail
    logger.debug("No metadata could be obtained")
    empty_metadata = BibliographicMetadata({
        "title": None,
        "authors": [],
        "date": None,
        "publisher": None,
        "journal": None,
        "volume": None,
        "issue": None,
        "pages": None,
        "doi": None,
        "id": None,
        "url": None
    })
    return validate_metadata(empty_metadata)
