"""
Base class for extraction engines.
"""

from abc import ABC, abstractmethod
from typing import Dict, List, Any, Optional


class BaseExtractor(ABC):
    """Base class for all extraction engines."""

    @classmethod
    @abstractmethod
    def get_info(cls) -> Dict[str, Any]:
        """
        Return information about this extractor.

        Returns:
            Dict with keys:
            - id: string identifier for this extractor
            - name: human-readable name
            - description: description of what this extractor does
            - input: list of supported input types ["pdf", "xml"]
            - output: list of supported output types ["tei-document", "tei-fragment"]
            - options: dict describing configurable options
        """
        pass

    @classmethod
    @abstractmethod
    def is_available(cls) -> bool:
        """
        Check if this extractor is available (dependencies installed, API keys set, etc.)

        Returns:
            True if the extractor can be used, False otherwise
        """
        pass

    async def check_ready(self, options: Optional[Dict[str, Any]] = None) -> Optional[str]:
        """
        Check whether an extraction can run now, e.g. whether a remote service is reachable.

        `is_available()` only tells whether the extractor is configured. This check is called
        through `POST /api/v1/extract/check` before steps that take long and must not be
        wasted, such as text recognition of the PDF, so that an extraction that would fail is
        not prepared in vain. Extractors that depend on a service should override it with a
        quick request; the default reports the extractor as ready.

        Args:
            options: The extraction options, as they will be passed to `extract()`

        Returns:
            None if the extractor is ready, otherwise a message for the user explaining why not
        """
        return None

    @abstractmethod
    async def extract(self, pdf_path: Optional[str] = None, xml_content: Optional[str] = None,
                      options: Dict[str, Any] = None) -> str:
        """
        Perform the extraction.

        Args:
            pdf_path: Path to PDF file (if input includes "pdf")
            xml_content: XML content as string (if input includes "xml")
            options: Dict of extraction options

        Returns:
            Extracted content as XML string

        Raises:
            ValueError: If required inputs are missing or invalid
            RuntimeError: If extraction fails
        """
        pass
