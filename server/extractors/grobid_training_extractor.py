"""
GROBID-based training data extraction engine
"""

import os
import requests
import zipfile
import tempfile
import datetime
import re
from typing import Dict, Any, Optional
from lxml import etree

from . import BaseExtractor
from server.lib.doi_utils import fetch_doi_metadata
from server.lib.tei_utils import (
    create_tei_header, 
    create_edition_stmt, 
    create_encoding_desc_with_grobid, 
    create_revision_desc_with_status,
    serialize_tei_xml
)


class GrobidTrainingExtractor(BaseExtractor):
    """GROBID-based training data extraction from PDF files."""

    @classmethod
    def get_info(cls) -> Dict[str, Any]:
        """Return information about the GROBID training extractor."""
        return {
            "id": "grobid-training",
            "name": "GROBID Training Data",
            "description": "Create training data for GROBID reference extraction using remote GROBID server",
            "input": ["pdf"],
            "output": ["tei-document"],
            "options": {
                "doi": {
                    "type": "string",
                    "description": "DOI of the document for metadata enrichment",
                    "required": False
                }
            }
        }
    
    @classmethod
    def is_available(cls) -> bool:
        """Check if GROBID server URL is configured."""
        grobid_server_url = os.environ.get("GROBID_SERVER_URL", "")
        return grobid_server_url != ""
    
    def extract(self, pdf_path: Optional[str] = None, xml_content: Optional[str] = None, 
                options: Dict[str, Any] = None) -> str:
        """
        Extract training data from PDF using GROBID.
        
        Args:
            pdf_path: Path to the PDF file
            xml_content: Not used by this extractor
            options: Extraction options (doi)
            
        Returns:
            Complete TEI document as XML string
        """
        # xml_content parameter required by interface but not used by this extractor
        _ = xml_content
        if not pdf_path:
            raise ValueError("PDF path is required for GROBID training extraction")
        
        if not self.is_available():
            raise RuntimeError("GROBID training extractor is not available - check GROBID_SERVER_URL environment variable")
        
        if options is None:
            options = {}
        
        # Get GROBID server info
        grobid_server_url = os.environ.get("GROBID_SERVER_URL")
        grobid_version, grobid_revision = self._get_grobid_version(grobid_server_url)
        
        # Create training data via GROBID API
        training_tei_content = self._create_training_data(pdf_path, grobid_server_url)
        
        # Clean invalid XML attributes before parsing
        training_tei_content = self._clean_invalid_xml_attributes(training_tei_content)
        
        # Parse the GROBID output
        grobid_doc = etree.fromstring(training_tei_content.encode('utf-8'))
        
        # Create new TEI document with proper namespace (no schema validation)
        tei_doc = etree.Element("TEI", nsmap={None: "http://www.tei-c.org/ns/1.0"})
        
        # Get DOI metadata if available
        doi = options.get("doi", "")
        metadata = {}
        if doi:
            try:
                metadata = fetch_doi_metadata(doi)
            except Exception as e:
                print(f"Warning: Could not fetch metadata for DOI {doi}: {e}")
        
        # Create TEI header
        tei_header = create_tei_header(doi, metadata)
        
        # Add custom elements to header
        timestamp = datetime.datetime.now().isoformat() + "Z"
        
        # Add editionStmt after titleStmt
        fileDesc = tei_header.find("fileDesc")
        titleStmt = fileDesc.find("titleStmt")
        edition_stmt = create_edition_stmt(timestamp, "Grobid document segmentation")
        titleStmt.addnext(edition_stmt)
        
        # Replace encodingDesc with GROBID-specific version
        existing_encodingDesc = tei_header.find("encodingDesc")
        if existing_encodingDesc is not None:
            tei_header.remove(existing_encodingDesc)
        
        encoding_desc = create_encoding_desc_with_grobid(grobid_version, grobid_revision, timestamp)
        tei_header.append(encoding_desc)
        
        # Replace revisionDesc with GROBID-specific version
        existing_revisionDesc = tei_header.find("revisionDesc")
        if existing_revisionDesc is not None:
            tei_header.remove(existing_revisionDesc)
        
        revision_desc = create_revision_desc_with_status(timestamp, "draft", "Generated with createTraining API")
        tei_header.append(revision_desc)
        
        # Add header to new document
        tei_doc.append(tei_header)
        
        # Extract and add the text content from GROBID output
        grobid_text = grobid_doc.find("text")
        if grobid_text is not None:
            # Copy the text element with all its content
            new_text = etree.SubElement(tei_doc, "text")
            new_text.attrib.update(grobid_text.attrib)
            new_text.text = grobid_text.text
            new_text.tail = grobid_text.tail
            for child in grobid_text:
                new_text.append(child)
        
        # Serialize with selective formatting: pretty-print header but preserve text content
        return self._serialize_training_tei(tei_doc)
    
    def _serialize_training_tei(self, tei_doc: etree.Element) -> str:
        """
        Serialize TEI document with selective formatting:
        - Pretty-print the teiHeader for readability
        - Preserve exact formatting of text element for training data
        """
        import xml.dom.minidom
        
        # Extract and temporarily remove the text element to preserve its formatting
        text_element = tei_doc.find("text")
        original_text_xml = None
        if text_element is not None:
            # Serialize the text element separately without any formatting changes
            original_text_xml = etree.tostring(text_element, encoding='unicode', method='xml')
            tei_doc.remove(text_element)
        
        # Pretty-print the remaining document (mainly the teiHeader)
        header_xml = etree.tostring(tei_doc, encoding='unicode', method='xml')
        pretty_header = xml.dom.minidom.parseString(header_xml).toprettyxml(indent="  ")
        
        # Clean up the pretty-printed header (remove xml declaration and empty lines)
        header_lines = [line for line in pretty_header.split('\n') if line.strip() and not line.startswith('<?xml')]
        
        # If we have a text element, we need to insert it back
        if original_text_xml:
            # Find the closing TEI tag and insert the text element before it
            closing_tei_idx = None
            for i, line in enumerate(header_lines):
                if '</TEI>' in line:
                    closing_tei_idx = i
                    break
            
            if closing_tei_idx is not None:
                # Insert the original text element before the closing TEI tag
                header_lines.insert(closing_tei_idx, f"  {original_text_xml}")
            else:
                # If no closing tag found, append it (shouldn't happen normally)
                header_lines.append(f"  {original_text_xml}")
                header_lines.append("</TEI>")
        
        return '\n'.join(header_lines)
    
    def _clean_invalid_xml_attributes(self, xml_content: str) -> str:
        """Clean invalid XML attributes that cause parsing errors."""
        # Fix invalid xml:id attributes like xml:id="-1" 
        xml_content = re.sub(r'xml:id="-?\d+"', 'xml:id="auto-generated"', xml_content)
        return xml_content
    
    def _get_grobid_version(self, grobid_server_url: str) -> tuple[str, str]:
        """Get GROBID version information from the server."""
        try:
            response = requests.get(f"{grobid_server_url}/api/version", timeout=30)
            response.raise_for_status()
            version_info = response.json()
            return version_info.get("version", "unknown"), version_info.get("revision", "unknown")
        except Exception as e:
            print(f"Warning: Could not fetch GROBID version: {e}")
            return "unknown", "unknown"
    
    def _create_training_data(self, pdf_path: str, grobid_server_url: str) -> str:
        """Create training data using GROBID createTraining API."""
        print(f"Creating training data from {pdf_path} via GROBID")
        
        # Create temporary directory for processing
        with tempfile.TemporaryDirectory() as temp_dir:
            # Call GROBID createTraining API
            url = f"{grobid_server_url}/api/createTraining"
            with open(pdf_path, 'rb') as pdf_file:
                files = {
                    'input': pdf_file,
                    'flavor': ('', 'article/dh-law-footnotes')
                }
                
                response = requests.post(url, files=files, timeout=300)  # 5 minute timeout
                response.raise_for_status()
            
            # Save ZIP file
            zip_path = os.path.join(temp_dir, 'training.zip')
            with open(zip_path, 'wb') as f:
                f.write(response.content)
            
            # Extract ZIP file
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(temp_dir)
            
            # Find the training segmentation file
            training_file = None
            for filename in os.listdir(temp_dir):
                if filename.endswith('.training.segmentation.tei.xml'):
                    training_file = os.path.join(temp_dir, filename)
                    break
            
            if not training_file:
                raise RuntimeError("Could not find .training.segmentation.tei.xml file in GROBID output")
            
            # Read the training file content
            with open(training_file, 'r', encoding='utf-8') as f:
                return f.read()