"""
LLamore-based reference extraction engine
"""

import os
from typing import Dict, Any, Optional
from lxml import etree

from . import BaseExtractor
from ..lib.doi_utils import fetch_doi_metadata
from ..lib.tei_utils import (
    create_tei_document,
    create_tei_header,
    create_revision_desc_with_status,
    create_schema_processing_instruction,
    serialize_tei_with_formatted_header
)
from ..lib.debug_utils import log_extraction_response, log_xml_parsing_error
import datetime

# Try to import LLamore dependencies
try:
    from llamore import GeminiExtractor, LineByLinePrompter, TeiBiblStruct  # type: ignore[import-untyped]
    LLAMORE_AVAILABLE = True
except ImportError:
    LLAMORE_AVAILABLE = False

GEMINI_MODEL = "gemini-2.0-flash"


class LLamoreExtractor(BaseExtractor):
    """LLamore-based reference extraction from PDF files."""

    @classmethod
    def get_models(cls) -> list:
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
                    "label": "DOI",
                    "description": "DOI of the document for metadata enrichment",
                    "required": False
                },
                "instructions": {
                    "type": "string",
                    "label": "Instructions",
                    "description": "Additional instructions for the extraction process",
                    "required": False
                },
                "variant_id": {
                    "type": "string",
                    "label": "Variant identifier", 
                    "description": "Variant identifier for the LLamore extraction",
                    "required": False,
                    "options": [
                        "llamore-default"
                    ]
                }
            },
            "navigation_xpath": {
                "llamore-default": [
                    {
                        "value": "//tei:biblStruct",
                        "label": "<biblStruct>"
                    },
                    {
                        "value": "//tei:biblStruct[@status='verified']",
                        "label": "Verified <biblStruct>"
                    },
                    {
                        "value": "//tei:biblStruct[not(@status='verified')]",
                        "label": "Unverified <biblStruct>"
                    },
                    {
                        "value": "//tei:biblStruct[@status='unresolved']",
                        "label": "Unresolved <biblStruct>"
                    }
                ]
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
                options: Optional[Dict[str, Any]] = None) -> str:
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
            
        # Create TEI document
        tei_doc = create_tei_document()
        
        # Create TEI header with metadata
        doi = options.get("doi", "")
        metadata = {}
        if doi:
            try:
                metadata = fetch_doi_metadata(doi)
            except Exception as e:
                print(f"Warning: Could not fetch metadata for DOI {doi}: {e}")
        
        # Create basic TEI header
        tei_header = create_tei_header(doi, metadata)
        assert tei_header is not None

        # Add editionStmt with fileref
        timestamp = datetime.datetime.now().isoformat() + "Z"
        # Use doc_id from options if provided, otherwise extract from PDF path
        file_id = options.get('doc_id')
        if not file_id:
            pdf_name = os.path.basename(pdf_path)
            file_id = os.path.splitext(pdf_name)[0]  # Remove .pdf extension

        fileDesc = tei_header.find("fileDesc")
        assert fileDesc is not None
        titleStmt = fileDesc.find("titleStmt")
        assert titleStmt is not None
        
        # Create editionStmt
        editionStmt = etree.Element("editionStmt")
        edition = etree.SubElement(editionStmt, "edition")
        date_elem = etree.SubElement(edition, "date", when=timestamp)
        date_elem.text = datetime.datetime.fromisoformat(timestamp.replace("Z", "+00:00")).strftime("%d.%m.%Y %H:%M:%S")
        title_elem = etree.SubElement(edition, "title")
        title_elem.text = "Extraction (llamore-gemini)"
        fileref_elem = etree.SubElement(edition, "idno", type="fileref")
        fileref_elem.text = file_id
        
        titleStmt.addnext(editionStmt)
        
        # Create encodingDesc with applications
        existing_encodingDesc = tei_header.find("encodingDesc")
        if existing_encodingDesc is not None:
            tei_header.remove(existing_encodingDesc)
            
        encodingDesc = etree.Element("encodingDesc")
        appInfo = etree.SubElement(encodingDesc, "appInfo")
        
        # PDF-TEI-Editor application
        pdf_tei_app = etree.SubElement(appInfo, "application",
                                      version="1.0",
                                      ident="pdf-tei-editor",
                                      type="editor")
        etree.SubElement(pdf_tei_app, "label").text = "PDF-TEI Editor"
        etree.SubElement(pdf_tei_app, "ref", target="https://github.com/mpilhlt/pdf-tei-editor")
        
        # LLamore extractor application
        llamore_app = etree.SubElement(appInfo, "application", 
                                     version="1.0", 
                                     ident="llamore", 
                                     when=timestamp,
                                     type="extractor")
        # Get variant_id from options using first value as default
        info = self.get_info()
        default_variant_id = info["options"]["variant_id"]["options"][0]  # "llamore-default"
        variant_id = options.get("variant_id", default_variant_id)
        
        variant_label = etree.SubElement(llamore_app, "label", type="variant-id")
        variant_label.text = variant_id
        prompter_label = etree.SubElement(llamore_app, "label", type="prompter")
        prompter_label.text = "LineByLinePrompter"
        etree.SubElement(llamore_app, "ref", target="https://github.com/mpilhlt/llamore")

        tei_header.append(encodingDesc)

        # Replace revisionDesc with LLamore-specific version
        existing_revisionDesc = tei_header.find("revisionDesc")
        if existing_revisionDesc is not None:
            tei_header.remove(existing_revisionDesc)

        revision_desc = create_revision_desc_with_status(timestamp, "extraction", "Generated with LLamore")
        tei_header.append(revision_desc)

        tei_doc.append(tei_header)
        
        # Extract references
        listBibl = self._extract_refs_from_pdf(pdf_path, options)
        
        # Log the extracted references XML for debugging
        refs_xml = etree.tostring(listBibl, encoding='unicode', method='xml', pretty_print=True)
        log_extraction_response("llamore", pdf_path, refs_xml, ".references.xml")
        
        standOff = etree.SubElement(tei_doc, "standOff")
        # Use list() instead of deprecated getchildren()
        children = list(listBibl)
        if children:
            standOff.append(children[0])

        # Create processing instruction for schema validation
        processing_instructions = []
        schema_url = 'https://mpilhlt.github.io/llamore/schema/llamore.rng'
        schema_pi = create_schema_processing_instruction(schema_url)
        processing_instructions.append(schema_pi)

        # Serialize to XML with formatted header
        return serialize_tei_with_formatted_header(tei_doc, processing_instructions)
    
    def _extract_refs_from_pdf(self, pdf_path: str, options: Dict[str, Any]) -> etree._Element:  # type: ignore[name-defined]
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
        
        # Generate XML and handle parsing errors
        xml_content = parser.to_xml(references)
        try:
            return etree.fromstring(xml_content)
        except etree.XMLSyntaxError as e:
            # Log the XML that failed to parse
            log_xml_parsing_error("llamore", pdf_path, xml_content, str(e))
            
            # Create a minimal document structure with error info instead of failing
            import html
            escaped_error = html.escape(str(e))
            error_xml = f'''<listBibl xmlns="http://www.tei-c.org/ns/1.0">
    <note type="error-message">{escaped_error}</note>
    <note type="invalid-xml"><![CDATA[
{xml_content}
]]></note>
</listBibl>'''
            
            # Parse this properly constructed XML
            return etree.fromstring(error_xml.encode('utf-8'))