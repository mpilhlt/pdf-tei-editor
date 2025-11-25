"""
Mock extraction engine for testing without external dependencies
"""

import os
import datetime
from typing import Dict, Any, Optional
from lxml import etree

from . import BaseExtractor
from server.lib.tei_utils import create_tei_document, create_tei_header, serialize_tei_with_formatted_header


class MockExtractor(BaseExtractor):
    """Mock extractor for testing without external dependencies."""

    @classmethod
    def get_info(cls) -> Dict[str, Any]:
        """Return information about the mock extractor."""
        return {
            "id": "mock-extractor",
            "name": "Mock Extractor",
            "description": "Mock extractor for testing without external dependencies (available in development and testing modes only)",
            "input": ["pdf", "xml"],
            "output": ["tei-document"],
            "options": {
                "doi": {
                    "type": "string",
                    "label": "DOI",
                    "description": "DOI of the document for metadata enrichment",
                    "required": False
                },
                "variant_id": {
                    "type": "string",
                    "label": "Variant identifier",
                    "description": "Variant identifier for the mock extraction",
                    "required": False,
                    "options": [
                        "mock-default"
                    ]
                }
            },
            "navigation_xpath": {
                "mock-default": [
                    {
                        "value": "//tei:biblStruct",
                        "label": "<biblStruct>"
                    }
                ]
            }
        }

    @classmethod
    def is_available(cls) -> bool:
        """Mock extractor available only in testing mode."""
        app_mode = os.environ.get("FASTAPI_APPLICATION_MODE", "development")
        return app_mode == "testing"

    def extract(self, pdf_path: Optional[str] = None, xml_content: Optional[str] = None,
                options: Dict[str, Any] = None) -> str:
        """
        Mock extraction that returns a simple TEI document.

        Args:
            pdf_path: Path to the PDF file (for PDF input)
            xml_content: XML content string (for XML input)
            options: Extraction options

        Returns:
            Complete TEI document as XML string
        """
        if not pdf_path and not xml_content:
            raise ValueError("Either PDF path or XML content is required for mock extraction")

        if options is None:
            options = {}

        # Create TEI document with RelaxNG schema
        tei_doc = create_tei_document("relaxng")

        # Create basic TEI header
        doi = options.get("doi", "")
        tei_header = create_tei_header(doi, {})

        # Add editionStmt with fileref
        timestamp = datetime.datetime.now().isoformat() + "Z"
        if pdf_path:
            file_name = os.path.basename(pdf_path)
            file_id = os.path.splitext(file_name)[0]  # Remove extension
        else:
            file_id = f"mock-extracted-{datetime.datetime.now().strftime('%Y%m%d-%H%M%S')}"

        fileDesc = tei_header.find("fileDesc")
        titleStmt = fileDesc.find("titleStmt")

        # Create editionStmt
        editionStmt = etree.Element("editionStmt")
        edition = etree.SubElement(editionStmt, "edition")
        date_elem = etree.SubElement(edition, "date", when=timestamp)
        date_elem.text = datetime.datetime.fromisoformat(timestamp.replace("Z", "+00:00")).strftime("%d.%m.%Y %H:%M:%S")
        title_elem = etree.SubElement(edition, "title")
        title_elem.text = "Mock extraction for testing"
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
        etree.SubElement(pdf_tei_app, "ref", target="https://github.com/mpilhlt/pdf-tei-editor")

        # Mock extractor application
        mock_app = etree.SubElement(appInfo, "application",
                                   version="1.0",
                                   ident="mock-extractor",
                                   when=timestamp,
                                   type="extractor")
        # Get variant_id from options
        info = self.get_info()
        default_variant_id = info["options"]["variant_id"]["options"][0]  # "mock-default"
        variant_id = options.get("variant_id", default_variant_id)

        variant_label = etree.SubElement(mock_app, "label", type="variant-id")
        variant_label.text = variant_id

        tei_header.append(encodingDesc)
        tei_doc.append(tei_header)

        # Create mock content with sample references
        standOff = etree.SubElement(tei_doc, "standOff")
        listBibl = etree.SubElement(standOff, "listBibl")

        # Add a few mock bibliography entries
        for i in range(3):
            biblStruct = etree.SubElement(listBibl, "biblStruct", status="verified")
            analytic = etree.SubElement(biblStruct, "analytic")
            title = etree.SubElement(analytic, "title", level="a", type="main")
            title.text = f"Mock Reference Title {i+1}"

            author = etree.SubElement(analytic, "author")
            persName = etree.SubElement(author, "persName")
            forename = etree.SubElement(persName, "forename", type="first")
            forename.text = f"John{i+1}"
            surname = etree.SubElement(persName, "surname")
            surname.text = f"Doe{i+1}"

            monogr = etree.SubElement(biblStruct, "monogr")
            title_monogr = etree.SubElement(monogr, "title", level="j")
            title_monogr.text = f"Mock Journal {i+1}"

            imprint = etree.SubElement(monogr, "imprint")
            date_imprint = etree.SubElement(imprint, "date", type="published", when=f"202{i}")
            date_imprint.text = f"202{i}"

        # Serialize to XML with formatted header
        return serialize_tei_with_formatted_header(tei_doc)