"""
DOI metadata utilities for fetching and parsing bibliographic information
"""

import re
import requests
from typing import Dict, Any


DOI_REGEX = r"^10.\d{4,9}/[-._;()/:A-Z0-9]+$"


def validate_doi(doi: str) -> bool:
    """Check if a DOI string is valid."""
    return bool(re.match(DOI_REGEX, doi, flags=re.IGNORECASE))


# Reversible filesystem encoding map
FILESYSTEM_ENCODING_MAP = {
    "/": "$1$",
    ":": "$2$", 
    "?": "$3$",
    "*": "$4$",
    "|": "$5$",
    "<": "$6$",
    ">": "$7$",
    "\"": "$8$",
    "\\": "$9$"
}

# Create reverse map for decoding
FILESYSTEM_DECODING_MAP = {v: k for k, v in FILESYSTEM_ENCODING_MAP.items()}


def doi_to_filename(doi: str) -> str:
    """
    Convert a DOI to a filesystem-safe filename using reversible encoding.
    
    Args:
        doi: The DOI string to convert
        
    Returns:
        A filesystem-safe string suitable for use as a filename
        
    Example:
        "10.1111/1467-6478.00040" -> "10.1111$1$1467-6478.00040"
    """
    if not doi:
        raise ValueError("DOI cannot be empty")
    
    filename = doi
    for char, encoded in FILESYSTEM_ENCODING_MAP.items():
        filename = filename.replace(char, encoded)
    
    return filename


def filename_to_doi(filename: str) -> str:
    """
    Convert a filesystem-safe filename back to a DOI using reversible decoding.
    
    Args:
        filename: The encoded filename to convert
        
    Returns:
        The original DOI string
        
    Example:
        "10.1111$1$1467-6478.00040" -> "10.1111/1467-6478.00040"
    """
    if not filename:
        raise ValueError("Filename cannot be empty")
    
    doi = filename
    for encoded, char in FILESYSTEM_DECODING_MAP.items():
        doi = doi.replace(encoded, char)
    
    return doi


def fetch_doi_metadata(doi: str) -> Dict[str, Any]:
    """
    Fetch metadata for DOI from CrossRef or DataCite APIs.
    
    Args:
        doi: The DOI string to fetch metadata for
        
    Returns:
        Dictionary with metadata fields: title, authors, date, publisher, journal, volume, issue, pages
        
    Raises:
        ValueError: If DOI format is invalid
        requests.exceptions.HTTPError: If both APIs fail
    """
    if not validate_doi(doi):
        raise ValueError(f"{doi} is not a valid DOI string")
    
    # Try CrossRef first
    try:
        return parse_crossref_metadata(doi)
    except requests.exceptions.HTTPError:
        # Fall back to DataCite
        return parse_datacite_metadata(doi)


def parse_crossref_metadata(doi: str) -> Dict[str, Any]:
    """Parse metadata from CrossRef API."""
    url = f"https://api.crossref.org/works/{doi}"
    response = requests.get(url)
    response.raise_for_status()
    data = response.json()
    
    message = data.get("message", {})
    title = message.get("title", [None])[0]
    authors_data = message.get("author", [])
    authors = [{"given": author.get("given"), "family": author.get("family")} for author in authors_data]
    
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


def parse_datacite_metadata(doi: str) -> Dict[str, Any]:
    """Parse metadata from DataCite API."""
    url = f"https://api.datacite.org/dois/{doi}"
    response = requests.get(url)
    response.raise_for_status()
    data = response.json()
    
    attributes = data.get("data", {}).get("attributes", {})
    title = attributes.get("titles", [{}])[0].get("title") if attributes.get("titles") else None
    
    authors_data = attributes.get("creators", [])
    authors = [{"given": author.get("givenName"), "family": author.get("familyName")} for author in authors_data]
    
    journal = attributes.get("container", {}).get("title") if attributes.get("container") else None
    
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