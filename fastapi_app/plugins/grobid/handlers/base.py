"""Base class for GROBID API endpoint handlers."""

from abc import ABC, abstractmethod
from typing import Dict, Any


class GrobidHandler(ABC):
    """Abstract base class for GROBID API endpoint handlers."""

    @abstractmethod
    def get_endpoint(self) -> str:
        """Return the GROBID API endpoint path (e.g., '/api/createTraining')."""

    @abstractmethod
    def get_supported_variants(self) -> list[str]:
        """Return list of variant IDs this handler supports."""

    @abstractmethod
    def fetch_tei(self, pdf_path: str, grobid_server_url: str,
                  variant_id: str, flavor: str, options: Dict[str, Any]) -> str:
        """
        Fetch TEI content from GROBID.

        Args:
            pdf_path: Path to the PDF file
            grobid_server_url: Base URL of the GROBID server
            variant_id: The variant identifier (e.g., 'grobid.training.references')
            flavor: Processing flavor (e.g., 'default')
            options: Additional extraction options

        Returns:
            Raw TEI XML string from GROBID
        """
