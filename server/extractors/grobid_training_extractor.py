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
    create_revision_desc_with_status,
    serialize_tei_with_formatted_header
)
from server.lib.debug_utils import log_extraction_response, log_xml_parsing_error


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
                },
                "variant_id": {
                    "type": "string",
                    "description": "Variant identifier for the training data type",
                    "required": False,
                    "options": [
                        "grobid.training.fulltext",
                        "grobid.training.segmentation", 
                        "grobid.training.references.referenceSegmenter"
                    ]
                },
                "flavor": {
                    "type": "string",
                    "description": "GROBID processing flavor",
                    "required": False,
                    "options": [
                        "default",
                        "article/dh-law-footnotes"
                    ]
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
        
        # Get options for flavor and variant_id using first value from options as default
        info = self.get_info()
        default_flavor = info["options"]["flavor"]["options"][0]  # "default"
        default_variant_id = info["options"]["variant_id"]["options"][0]  # "grobid.training.fulltext"
        
        flavor = options.get("flavor", default_flavor)
        variant_id = options.get("variant_id")
        if not variant_id:
            variant_id = default_variant_id
        
        # Get GROBID server info
        grobid_server_url = os.environ.get("GROBID_SERVER_URL")
        if grobid_server_url is None:
            raise ValueError("No Grobid server URL")
        grobid_version, grobid_revision = self._get_grobid_version(grobid_server_url)
        
        # Create training data via GROBID API
        training_tei_content = self._create_training_data(pdf_path, grobid_server_url, variant_id, flavor)
        
        # Log raw GROBID response for debugging
        log_extraction_response("grobid", pdf_path, training_tei_content, ".raw.xml")
        
        # Clean invalid XML attributes before parsing
        training_tei_content = self._clean_invalid_xml_attributes(training_tei_content)
        
        # Log cleaned content for debugging
        log_extraction_response("grobid", pdf_path, training_tei_content, ".cleaned.xml")
        
        # Parse the GROBID output
        try:
            grobid_doc = etree.fromstring(training_tei_content.encode('utf-8'))
        except etree.XMLSyntaxError as e:
            # Log the XML that failed to parse
            log_xml_parsing_error("grobid", pdf_path, training_tei_content, str(e))
            raise RuntimeError(f"XML parsing failed: {e}") from e
        
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
        
        # Add editionStmt after titleStmt with fileref
        fileDesc = tei_header.find("fileDesc")
        titleStmt = fileDesc.find("titleStmt")
        edition_stmt = create_edition_stmt(timestamp, f"{variant_id} [{flavor}]")
        
        # Add fileref to edition - extract from PDF path
        pdf_name = os.path.basename(pdf_path)
        file_id = os.path.splitext(pdf_name)[0]  # Remove .pdf extension
        
        edition = edition_stmt.find("edition")
        if edition is not None:
            fileref_elem = etree.SubElement(edition, "idno", type="fileref")
            fileref_elem.text = file_id
        
        titleStmt.addnext(edition_stmt)
        
        # Replace encodingDesc with GROBID-specific version
        existing_encodingDesc = tei_header.find("encodingDesc")
        if existing_encodingDesc is not None:
            tei_header.remove(existing_encodingDesc)
        
        # Create encodingDesc with applications
        encodingDesc = etree.Element("encodingDesc")
        appInfo = etree.SubElement(encodingDesc, "appInfo")
        
        # PDF-TEI-Editor application
        pdf_tei_app = etree.SubElement(appInfo, "application", 
                                      version="1.0", 
                                      ident="pdf-tei-editor",
                                      type="editor")
        etree.SubElement(pdf_tei_app, "ref", target="https://github.com/mpilhlt/pdf-tei-editor")
        
        # GROBID extractor application
        grobid_app = etree.SubElement(appInfo, "application", 
                                     version=grobid_version, 
                                     ident="GROBID", 
                                     when=timestamp,
                                     type="extractor")
        desc = etree.SubElement(grobid_app, "desc")
        desc.text = "GROBID - A machine learning software for extracting information from scholarly documents"
        
        revision_label = etree.SubElement(grobid_app, "label", type="revision")
        revision_label.text = grobid_revision
        
        flavor_label = etree.SubElement(grobid_app, "label", type="flavor")
        flavor_label.text = flavor
        
        variant_label = etree.SubElement(grobid_app, "label", type="variant-id")
        variant_label.text = variant_id
        
        etree.SubElement(grobid_app, "ref", target="https://github.com/kermitt2/grobid")
        
        tei_header.append(encodingDesc)
        
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
        return serialize_tei_with_formatted_header(tei_doc)
    
    
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
    
    def _create_training_data(self, pdf_path: str, grobid_server_url: str, variant_id: str, flavor: str) -> str:
        """Create training data using GROBID createTraining API."""
        print(f"Creating training data from {pdf_path} via GROBID")
        
        # Create temporary directory for processing
        with tempfile.TemporaryDirectory() as temp_dir:
            # Call GROBID createTraining API
            url = f"{grobid_server_url}/api/createTraining"
            with open(pdf_path, 'rb') as pdf_file:
                files = {
                    'input': pdf_file,
                    'flavor': ('', flavor)
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
            
            # Find the file that corresponds to the variant
            training_file = None
            suffix = f'.{variant_id.removeprefix("grobid.")}.tei.xml' 
            for filename in os.listdir(temp_dir):
                if filename.endswith(suffix):
                    training_file = os.path.join(temp_dir, filename)
                    break
            
            if not training_file:
                raise RuntimeError(f"Could not find '*{suffix}' file in GROBID output")
            
            # Read the training file content
            with open(training_file, 'r', encoding='utf-8') as f:
                return f.read()