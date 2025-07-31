"""
LLamore-based reference extraction engine
"""

import os
from typing import Dict, Any, Optional
from lxml import etree

from . import BaseExtractor
from server.lib.doi_utils import fetch_doi_metadata
from server.lib.tei_utils import create_tei_document, create_tei_header, serialize_tei_xml

# Try to import LLamore dependencies
try:
    from llamore import GeminiExtractor, LineByLinePrompter, TeiBiblStruct
    LLAMORE_AVAILABLE = True
except ImportError:
    LLAMORE_AVAILABLE = False

GEMINI_MODEL = "gemini-2.0-flash"


class LLamoreExtractor(BaseExtractor):
    """LLamore-based reference extraction from PDF files."""

    @classmethod
    def get_models() -> list:
        return [GEMINI_MODEL] 
    
    @classmethod
    def get_info(cls) -> Dict[str, Any]:
        """Return information about the LLamore extractor."""
        return {
            "id": "llamore-gemini",
            "name": "LLamore + Gemini",
            "description": "Extract bibliographic references from PDF using LLamore library with Gemini AI",
            "input": ["pdf"],
            "output": ["tei-document"],
            "options": {
                "doi": {
                    "type": "string",
                    "description": "DOI of the document for metadata enrichment",
                    "required": False
                },
                "instructions": {
                    "type": "string", 
                    "description": "Additional instructions for the extraction process",
                    "required": False
                }
            }
        }
    
    @classmethod
    def is_available(cls) -> bool:
        """Check if LLamore and Gemini API key are available."""
        if not LLAMORE_AVAILABLE:
            return False
        
        gemini_api_key = os.environ.get("GEMINI_API_KEY", "")
        return gemini_api_key != ""
    
    def extract(self, pdf_path: Optional[str] = None, xml_content: Optional[str] = None, 
                options: Dict[str, Any] = None) -> str:
        """
        Extract references from PDF using LLamore.
        
        Args:
            pdf_path: Path to the PDF file
            xml_content: Not used by this extractor
            options: Extraction options (doi, instructions)
            
        Returns:
            Complete TEI document as XML string
        """
        if not pdf_path:
            raise ValueError("PDF path is required for LLamore extraction")
        
        if not self.is_available():
            raise RuntimeError("LLamore extractor is not available - check dependencies and API key")
        
        if options is None:
            options = {}
            
        # Create TEI document with RelaxNG schema
        tei_doc = create_tei_document("relaxng")
        
        # Create TEI header with metadata
        doi = options.get("doi", "")
        metadata = {}
        if doi:
            try:
                metadata = fetch_doi_metadata(doi)
            except Exception as e:
                print(f"Warning: Could not fetch metadata for DOI {doi}: {e}")
        
        applications = [
            {"ident": "llamore", "version": "1.0", "label": "https://github.com/mpilhlt/llamore"},
            {"ident": "pdf-tei-editor", "version": "1.0", "label": "https://github.com/mpilhlt/pdf-tei-editor"},
            {"ident": "model", "version": "1.0", "label": "Gemini 2.0/LineByLinePrompter"}
        ]
        
        tei_header = create_tei_header(doi, metadata, applications)
        tei_doc.append(tei_header)
        
        # Extract references
        listBibl = self._extract_refs_from_pdf(pdf_path, options)
        standOff = etree.SubElement(tei_doc, "standOff")
        standOff.append(listBibl.getchildren()[0])
        
        # Serialize to XML
        return serialize_tei_xml(tei_doc)
    
    def _extract_refs_from_pdf(self, pdf_path: str, options: Dict[str, Any]) -> etree.Element:
        """Extract references from PDF using LLamore."""
        print(f"Extracting references from {pdf_path} via LLamore/Gemini")
        
        gemini_api_key = os.environ.get("GEMINI_API_KEY", "")
        
        class CustomPrompter(LineByLinePrompter):
            def user_prompt(self, text=None, additional_instructions="") -> str:
                instructions = options.get("instructions", None)
                if instructions:
                    additional_instructions += "In particular, follow these rules:\n\n" + instructions
                return super().user_prompt(text, additional_instructions)
        
        extractor = GeminiExtractor(api_key=gemini_api_key, prompter=CustomPrompter(), model=GEMINI_MODEL)
        references = extractor(pdf_path)
        parser = TeiBiblStruct()
        return etree.fromstring(parser.to_xml(references))