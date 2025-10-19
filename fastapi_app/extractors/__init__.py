"""
Extractor plugin system for PDF-TEI Editor

This module provides a plugin-based architecture for different extraction engines.
"""

from abc import ABC, abstractmethod
from typing import Dict, List, Any, Optional
from pathlib import Path


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
    
    @abstractmethod
    def extract(self, pdf_path: Optional[str] = None, xml_content: Optional[str] = None, 
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