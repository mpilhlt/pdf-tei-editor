"""
Bibliographic metadata extraction utilities for retrieving document metadata.

Provides:
- Metadata extraction from PDFs via extraction service
- LLM-based metadata parsing with JSON schema validation
- Fallback mechanisms for when DOI lookup fails
"""

import logging
from typing import Dict, Any

logger = logging.getLogger(__name__)

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
        "doi": {"type": "string", "description": "DOI if found in document"}
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
- doi: DOI if present in the document

Critical rules:
- Return the information as JSON matching the expected schema. 
- Only include fields where you can find the information.
- If author names are in all-caps, return them properly capitalized
"""


def _normalize_extracted_metadata(data: Dict[str, Any]) -> Dict[str, Any]:
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

    return {
        "title": data.get("title"),
        "authors": authors,
        "date": data.get("date"),
        "publisher": data.get("publisher"),
        "journal": data.get("journal"),
        "volume": data.get("volume"),
        "issue": data.get("issue"),
        "pages": data.get("pages"),
    }


async def get_metadata_for_document(
    doi: str | None = None,
    pdf_path: str | None = None,
    text_content: str | None = None,
    stable_id: str | None = None,
) -> Dict[str, Any]:
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
    # 1. Try DOI lookup first if DOI provided
    if doi:
        from .doi_utils import normalize_doi, validate_doi, fetch_doi_metadata
        
        doi = normalize_doi(doi)
        if validate_doi(doi):
            try:
                logger.debug(f"Attempting DOI metadata lookup for: {doi}")
                return fetch_doi_metadata(doi)
            except Exception as e:
                logger.warning(f"DOI lookup failed for {doi}: {e}")
        else:
            logger.warning(f"Invalid DOI format, skipping lookup: {doi}")

    # 2. Fallback to extraction service if stable_id or text_content is available
    if stable_id or text_content:
        try:
            from fastapi_app.lib.service_registry import get_service_registry

            service = get_service_registry().get_extraction_service()

            if service:
                logger.debug("Attempting metadata extraction via service")

                # Get available models to find one that supports the input type
                model = None
                required_input = "image" if stable_id else "text"

                if hasattr(service, '_extractor') and hasattr(service._extractor, 'get_models_with_capabilities'):
                    models = service._extractor.get_models_with_capabilities()
                    for m in models:
                        if required_input in m.get("input", []):
                            model = m["id"]
                            break
                    # Fallback to first available model
                    if not model and models:
                        model = models[0]["id"]

                # For DummyExtractionService (testing), use a default model
                if not model:
                    model = "default-model"

                # Extract with individual parameters (matching actual implementation)
                result = await service.extract(
                    model=model,
                    prompt=BIBLIOGRAPHIC_METADATA_PROMPT,
                    stable_id=stable_id,
                    text_input=text_content,
                    json_schema=BIBLIOGRAPHIC_METADATA_SCHEMA,
                    temperature=0.1,
                    max_retries=2
                )

                if result.get("success"):
                    logger.debug("Metadata extraction via service succeeded")
                    return _normalize_extracted_metadata(result.get("data", {}))
                else:
                    logger.warning(f"Metadata extraction failed: {result.get('error')}")

        except ImportError:
            logger.debug("Service registry not available, skipping extraction fallback")
        except Exception as e:
            logger.warning(f"Extraction service fallback failed: {e}")

    # 3. Return empty metadata if all methods fail
    logger.debug("No metadata could be obtained")
    return {}