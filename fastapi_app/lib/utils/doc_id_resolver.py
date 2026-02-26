"""
DOI resolution and filename encoding for cross-platform filesystem compatibility.

This module handles:
1. DOI - filename encoding (filesystem-safe, human-readable)
2. PDF-TEI matching using multiple strategies
3. Backward compatibility with Flask encoding formats
4. Document ID resolution with intelligent fallbacks
"""

import re
from pathlib import Path
from typing import Optional, Tuple, List, Dict, Any
from fastapi_app.lib.services.metadata_extraction import BibliographicMetadata
import logging

logger = logging.getLogger(__name__)

# DOI validation regex (from CrossRef specification)
DOI_REGEX = r"^10\.\d{4,9}/[-._;()/:A-Z0-9]+$"

# Flask legacy encoding map (for backward compatibility)
FLASK_ENCODING_MAP = {
    "/": "$1$",
    ":": "$2$",
    "?": "$3$",
    "*": "$4$",
    "|": "$5$",
    "<": "$6$",
    ">": "$7$",
    '"': "$8$",
    "\\": "$9$"
}

FLASK_DECODING_MAP = {v: k for k, v in FLASK_ENCODING_MAP.items()}

# Characters that appear in legacy (pre-2008) DOIs but not modern ones
LEGACY_DOI_CHARS = [":", "<", ">", "|", "?", "*", "\\", '"']


class DocIdResolver:
    """
    Resolve document IDs (preferring DOIs) and encode them for filesystem storage.

    Modern approach (for 99.9% of DOIs):
        - Encode: "/" -> "__"  (double underscore)
        - Human-readable, filesystem-safe, reversible
        - Example: "10.5771/2699-1284-2024-3-149" - "10.5771__2699-1284-2024-3-149"

    Legacy approach (pre-2008 DOIs with special chars):
        - Hybrid: "/" -> "__", other special chars -> "$x$"
        - Example: "10.1234/old:doi" -> "10.1234__old$2$doi"

    Backward compatibility:
        - Detects and decodes Flask pure "$1$" format
        - Detects and decodes demo "__" format
        - Detects and decodes hybrid formats
    """

    def encode_doi_to_filename(self, doi: str) -> str:
        """
        Encode DOI to filesystem-safe filename.

        For modern DOIs (post-2008), uses double-underscore encoding.
        For legacy DOIs with special characters, uses hybrid encoding.

        Args:
            doi: DOI string (e.g., "10.5771/2699-1284-2024-3-149")

        Returns:
            Filesystem-safe filename (e.g., "10.5771__2699-1284-2024-3-149")

        Examples:
            >>> resolver.encode_doi_to_filename("10.5771/2699-1284-2024-3-149")
            "10.5771__2699-1284-2024-3-149"

            >>> resolver.encode_doi_to_filename("10.1234/old:doi")  # Legacy
            "10.1234__old$2$doi"
        """
        if not doi:
            return doi

        # Check for legacy special characters
        has_legacy_chars = any(char in doi for char in LEGACY_DOI_CHARS)

        if has_legacy_chars:
            # Hybrid encoding: __ for /, $x$ for others
            logger.debug(f"Using hybrid encoding for legacy DOI: {doi}")
            return self._encode_hybrid_format(doi)

        # Modern DOI: just replace / with __
        return doi.replace("/", "__")

    def decode_filename_to_doi(self, filename: str) -> str:
        """
        Decode filename to DOI, handling multiple legacy formats.

        Supports:
        - Modern double-underscore: "10.5771__xxx" -> "10.5771/xxx"
        - Flask pure $x$: "10.5771$1$xxx" -> "10.5771/xxx"
        - Hybrid: "10.5771__old$2$doi" -> "10.5771/old:doi"

        Args:
            filename: Encoded filename

        Returns:
            Decoded DOI or original string if not encoded

        Examples:
            >>> resolver.decode_filename_to_doi("10.5771__2699-1284-2024-3-149")
            "10.5771/2699-1284-2024-3-149"

            >>> resolver.decode_filename_to_doi("10.5771$1$2699-1284-2024-3-149")  # Flask
            "10.5771/2699-1284-2024-3-149"
        """
        if not filename:
            return filename

        # Remove common file extensions (but preserve DOI periods!)
        stem = filename
        for ext in ['.pdf', '.xml', '.tei.xml', '.PDF', '.XML']:
            if stem.endswith(ext):
                stem = stem[:-len(ext)]
                break

        # 1. Detect Flask pure $x$ format (no __)
        if "$1$" in stem and "__" not in stem:
            return self._decode_flask_format(stem)

        # 2. Detect hybrid format (both __ and $x$)
        if "__" in stem and "$" in stem:
            return self._decode_hybrid_format(stem)

        # 3. Detect pure double-underscore format (modern)
        if "__" in stem:
            return stem.replace("__", "/")

        # 4. Not encoded (custom ID or filename)
        return stem

    def looks_like_doi(self, text: str) -> bool:
        """
        Check if text matches DOI pattern.

        Args:
            text: String to check

        Returns:
            True if text matches DOI regex

        Examples:
            >>> resolver.looks_like_doi("10.5771/2699-1284-2024-3-149")
            True
            >>> resolver.looks_like_doi("just-a-filename")
            False
        """
        if not text:
            return False
        return bool(re.match(DOI_REGEX, text, flags=re.IGNORECASE))

    def extract_doi_from_filename(self, filename: str) -> Optional[str]:
        """
        Extract DOI from filename if it contains one.

        Tries decoding first, then checks if result is a valid DOI.

        Args:
            filename: Filename that may contain encoded DOI

        Returns:
            DOI string if found, None otherwise

        Examples:
            >>> resolver.extract_doi_from_filename("10.5771__2699-1284-2024-3-149.pdf")
            "10.5771/2699-1284-2024-3-149"

            >>> resolver.extract_doi_from_filename("random-file-123.pdf")
            None
        """
        decoded = self.decode_filename_to_doi(filename)
        if self.looks_like_doi(decoded):
            return decoded
        return None

    def resolve_doc_id_for_pdf(
        self,
        pdf_path: Path,
        matching_teis: List[Tuple[Path, Dict[str, Any]]],
        tei_metadata: Dict[Path, Dict[str, Any]]
    ) -> Tuple[str, str]:
        """
        Resolve document ID for a PDF file using multiple strategies.

        Priority order:
        1. DOI from matching TEI file
        2. Fileref from matching TEI file
        3. DOI from PDF filename (if it looks like a DOI)
        4. PDF filename as custom ID

        Args:
            pdf_path: Path to PDF file
            matching_teis: List of matching TEI file paths with their metadata
            tei_metadata: Dict mapping TEI paths to their metadata

        Returns:
            Tuple of (doc_id, doc_id_type) where doc_id_type is 'doi', 'fileref', or 'custom'

        Examples:
            With matching TEI containing DOI:
                -> ("10.5771/2699-1284-2024-3-149", "doi")

            Without TEI, filename is "10.5771__2699-1284-2024-3-149.pdf":
                -> ("10.5771/2699-1284-2024-3-149", "doi")

            Without TEI, filename is "my-paper.pdf":
                -> ("my-paper", "custom")
        """
        # Strategy 1: Get DOI from matching TEI
        if matching_teis:
            tei_path, metadata = matching_teis[0]  # Use first match
            if metadata.get('doc_id'):
                doc_id_type = metadata.get('doc_id_type', 'doi')
                logger.debug(f"Resolved PDF {pdf_path.name} -> {metadata['doc_id']} from TEI")
                return (metadata['doc_id'], doc_id_type)

            # Fallback to fileref
            if metadata.get('fileref'):
                logger.debug(f"Resolved PDF {pdf_path.name} -> {metadata['fileref']} from TEI fileref")
                return (metadata['fileref'], 'fileref')

        # Strategy 2: Extract DOI from PDF filename
        doi = self.extract_doi_from_filename(pdf_path.name)
        if doi:
            logger.debug(f"Resolved PDF {pdf_path.name} -> {doi} from filename")
            return (doi, 'doi')

        # Strategy 3: Use filename as custom ID
        doc_id = pdf_path.stem
        logger.debug(f"Resolved PDF {pdf_path.name} -> {doc_id} (custom ID)")
        return (doc_id, 'custom')

    def resolve_doc_id_for_tei(self, tei_metadata: BibliographicMetadata) -> Tuple[str, str]:
        """
        Resolve document ID for a TEI file from its metadata.

        Priority order:
        1. DOI from <idno type="DOI">
        2. Fileref from <idno type="fileref">
        3. Filename as custom ID

        Args:
            tei_metadata: Metadata extracted from TEI file

        Returns:
            Tuple of (doc_id, doc_id_type)
        """
        doc_id = tei_metadata.get('doc_id')
        if doc_id:
            doc_id_type = tei_metadata.get('doc_id_type', 'doi') or 'doi'
            return (doc_id, doc_id_type)

        fileref = tei_metadata.get('fileref')
        if fileref:
            return (fileref, 'fileref')

        # This shouldn't happen as extract_tei_metadata should always set doc_id
        # but include for safety - use empty string instead of None
        return ("", 'custom')

    def find_matching_teis(
        self,
        pdf_path: Path,
        tei_files: List[Path],
        tei_metadata: Dict[Path, Dict[str, Any]]
    ) -> List[Tuple[Path, Dict[str, Any]]]:
        """
        Find TEI files that match the given PDF.

        Matching strategies (in order of priority):
        1. Exact filename stem match
        2. Normalized filename match (handles different encodings)
        3. TEI fileref matches PDF stem
        4. Both decode to same DOI

        Args:
            pdf_path: Path to PDF file
            tei_files: List of all TEI file paths
            tei_metadata: Dict mapping TEI paths to their metadata

        Returns:
            List of tuples (tei_path, metadata) for matching TEIs, ordered by priority
        """
        pdf_stem = pdf_path.stem
        pdf_stem_decoded = self.decode_filename_to_doi(pdf_stem)

        matches = []

        for tei_path in tei_files:
            tei_stem = tei_path.stem.replace('.tei', '')
            metadata = tei_metadata.get(tei_path, {})

            # Strategy 1: Exact filename stem match
            if pdf_stem == tei_stem:
                matches.append((tei_path, metadata, 1))
                continue

            # Strategy 2: Normalized match (both decode to same string)
            tei_stem_decoded = self.decode_filename_to_doi(tei_stem)
            if pdf_stem_decoded == tei_stem_decoded:
                matches.append((tei_path, metadata, 2))
                continue

            # Strategy 3: TEI fileref matches PDF stem
            fileref = metadata.get('fileref', '')
            if fileref:
                fileref_normalized = fileref.replace('.pdf', '')
                if pdf_stem == fileref_normalized or pdf_stem_decoded == self.decode_filename_to_doi(fileref_normalized):
                    matches.append((tei_path, metadata, 3))
                    continue

            # Strategy 4: Both have same DOI (regardless of encoding)
            pdf_doi = self.extract_doi_from_filename(pdf_stem)
            tei_doi = metadata.get('doc_id')
            if pdf_doi and tei_doi and pdf_doi == tei_doi:
                matches.append((tei_path, metadata, 4))
                continue

        # Sort by priority (lower number = higher priority)
        matches.sort(key=lambda x: x[2])

        # Return without priority number
        return [(path, metadata) for path, metadata, _ in matches]

    def _encode_hybrid_format(self, doi: str) -> str:
        """Encode using hybrid format: __ for /, $x$ for special chars"""
        # First replace / with __
        result = doi.replace("/", "__")

        # Then encode other special characters
        for char, encoded in FLASK_ENCODING_MAP.items():
            if char != "/":  # Already handled /
                result = result.replace(char, encoded)

        return result

    def _decode_flask_format(self, filename: str) -> str:
        """Decode Flask pure $x$ format"""
        result = filename
        for encoded, char in FLASK_DECODING_MAP.items():
            result = result.replace(encoded, char)
        return result

    def _decode_hybrid_format(self, filename: str) -> str:
        """Decode hybrid format: __ and $x$"""
        # First decode $x$ sequences
        result = self._decode_flask_format(filename)
        # Then decode __ to /
        result = result.replace("__", "/")
        return result
