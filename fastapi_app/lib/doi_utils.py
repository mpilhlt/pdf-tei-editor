"""
DOI metadata utilities for fetching and parsing bibliographic information.

Ported from Flask implementation with enhancements.
"""

import re
import requests
from typing import Dict, Any, Optional
import logging

logger = logging.getLogger(__name__)

# DOI validation regex (from CrossRef specification)
# Matches: 10.{4-9 digits}/{suffix with allowed characters}
# Allowed suffix characters: A-Z 0-9 -._;()/
DOI_REGEX = r"^10\.\d{4,9}/[-._;()/:A-Z0-9]+$"


def validate_doi(doi: str) -> bool:
    """
    Check if a DOI string is valid according to CrossRef specifications.

    Args:
        doi: The DOI string to validate

    Returns:
        True if DOI matches the valid pattern, False otherwise

    Examples:
        >>> validate_doi("10.5771/2699-1284-2024-3-149")
        True
        >>> validate_doi("not-a-doi")
        False
        >>> validate_doi("10.1234/valid-doi_123")
        True
    """
    if not doi:
        return False
    return bool(re.match(DOI_REGEX, doi, flags=re.IGNORECASE))


def fetch_doi_metadata(doi: str, timeout: int = 10) -> Dict[str, Any]:
    """
    Fetch metadata for DOI from CrossRef or DataCite APIs.

    Tries CrossRef first (most common), falls back to DataCite.

    Args:
        doi: The DOI string to fetch metadata for
        timeout: Request timeout in seconds (default: 10)

    Returns:
        Dictionary with metadata fields:
            - title: Article/document title
            - authors: List of dicts with 'given' and 'family' name
            - date: Publication year
            - publisher: Publisher name
            - journal: Journal/container title
            - volume: Volume number
            - issue: Issue number
            - pages: Page range

    Raises:
        ValueError: If DOI format is invalid
        requests.exceptions.HTTPError: If both APIs fail
        requests.exceptions.Timeout: If request times out

    Examples:
        >>> metadata = fetch_doi_metadata("10.5771/2699-1284-2024-3-149")
        >>> metadata['title']
        "Legal status of Derived Text Formats..."
    """
    if not validate_doi(doi):
        raise ValueError(f"{doi} is not a valid DOI string")

    # Try CrossRef first (more common for academic papers)
    try:
        logger.debug(f"Fetching metadata from CrossRef for DOI: {doi}")
        return parse_crossref_metadata(doi, timeout)
    except requests.exceptions.HTTPError as e:
        logger.warning(f"CrossRef API failed for {doi}: {e}")
        # Fall back to DataCite
        try:
            logger.debug(f"Falling back to DataCite for DOI: {doi}")
            return parse_datacite_metadata(doi, timeout)
        except requests.exceptions.HTTPError as e2:
            logger.error(f"Both CrossRef and DataCite APIs failed for {doi}")
            raise


def parse_crossref_metadata(doi: str, timeout: int = 10) -> Dict[str, Any]:
    """
    Parse metadata from CrossRef API.

    Args:
        doi: The DOI to look up
        timeout: Request timeout in seconds

    Returns:
        Dictionary with parsed metadata

    Raises:
        requests.exceptions.HTTPError: If API request fails
    """
    url = f"https://api.crossref.org/works/{doi}"
    response = requests.get(url, timeout=timeout)
    response.raise_for_status()
    data = response.json()

    message = data.get("message", {})

    # Extract title
    title = message.get("title", [None])[0]

    # Extract authors
    authors_data = message.get("author", [])
    authors = [
        {"given": author.get("given"), "family": author.get("family")}
        for author in authors_data
    ]

    # Extract publication date
    issued_data = message.get("issued", {})
    date_parts = issued_data.get("date-parts", [[]])
    date = date_parts[0][0] if date_parts and date_parts[0] else None

    return {
        "title": title,
        "authors": authors,
        "date": date,
        "publisher": message.get("publisher"),
        "journal": message.get("container-title", [None])[0],
        "volume": message.get("volume"),
        "issue": message.get("issue"),
        "pages": message.get("page"),
    }


def parse_datacite_metadata(doi: str, timeout: int = 10) -> Dict[str, Any]:
    """
    Parse metadata from DataCite API.

    Args:
        doi: The DOI to look up
        timeout: Request timeout in seconds

    Returns:
        Dictionary with parsed metadata

    Raises:
        requests.exceptions.HTTPError: If API request fails
    """
    url = f"https://api.datacite.org/dois/{doi}"
    response = requests.get(url, timeout=timeout)
    response.raise_for_status()
    data = response.json()

    attributes = data.get("data", {}).get("attributes", {})

    # Extract title
    title = None
    if attributes.get("titles"):
        title = attributes["titles"][0].get("title")

    # Extract authors (creators in DataCite)
    authors_data = attributes.get("creators", [])
    authors = [
        {"given": author.get("givenName"), "family": author.get("familyName")}
        for author in authors_data
    ]

    # Extract journal/container
    journal = None
    if attributes.get("container"):
        journal = attributes["container"].get("title")

    return {
        "title": title,
        "authors": authors,
        "date": attributes.get("publicationYear"),
        "publisher": attributes.get("publisher"),
        "journal": journal,
        "volume": attributes.get("volume", ""),
        "issue": attributes.get("issue", ""),
        "pages": attributes.get("page"),
    }


def normalize_doi(doi: str) -> str:
    """
    Normalize a DOI string.

    - Removes leading/trailing whitespace
    - Removes common prefixes (doi:, http://doi.org/, https://doi.org/)
    - Converts to lowercase (DOIs are case-insensitive)

    Args:
        doi: DOI string to normalize

    Returns:
        Normalized DOI string

    Examples:
        >>> normalize_doi("  10.5771/2699-1284-2024-3-149  ")
        "10.5771/2699-1284-2024-3-149"
        >>> normalize_doi("doi:10.5771/2699-1284-2024-3-149")
        "10.5771/2699-1284-2024-3-149"
        >>> normalize_doi("https://doi.org/10.5771/2699-1284-2024-3-149")
        "10.5771/2699-1284-2024-3-149"
    """
    if not doi:
        return doi

    # Strip whitespace
    doi = doi.strip()

    # Remove common DOI prefixes
    prefixes = [
        "doi:",
        "DOI:",
        "http://doi.org/",
        "https://doi.org/",
        "http://dx.doi.org/",
        "https://dx.doi.org/",
    ]

    for prefix in prefixes:
        if doi.startswith(prefix):
            doi = doi[len(prefix):]
            break

    # DOIs are case-insensitive, but conventionally lowercase
    # However, keep original case for compatibility
    return doi
