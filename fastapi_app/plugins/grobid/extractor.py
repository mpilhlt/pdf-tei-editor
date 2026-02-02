"""
GROBID-based extraction engine supporting multiple API endpoints.
"""

import os
import datetime
import re
from typing import Dict, Any, Optional
from lxml import etree

from fastapi_app.lib.extraction import BaseExtractor, get_retry_session
from fastapi_app.lib.doi_utils import get_metadata_for_document
from fastapi_app.plugins.grobid.config import (
    get_annotation_guides,
    get_form_options,
    get_navigation_xpath
)
from fastapi_app.plugins.grobid.handlers import (
    GrobidHandler,
    TrainingHandler,
    FulltextHandler,
    ReferencesHandler,
)
from fastapi_app.lib.tei_utils import (
    create_tei_header,
    create_revision_desc_with_status,
    create_schema_processing_instruction,
    serialize_tei_with_formatted_header,
    get_file_id_from_options,
    create_edition_stmt_with_fileref,
    create_encoding_desc_with_extractor,
)
from fastapi_app.lib.debug_utils import log_extraction_response, log_xml_parsing_error


class GrobidTrainingExtractor(BaseExtractor):
    """GROBID-based extraction from PDF files supporting multiple API endpoints."""

    def __init__(self):
        """Initialize handlers for different GROBID API endpoints."""
        self._handlers: dict[str, GrobidHandler] = {
            "grobid.training": TrainingHandler(),
            "grobid.service.fulltext": FulltextHandler(),
            "grobid.service.references": ReferencesHandler(),
        }

    def _get_handler(self, variant_id: str) -> GrobidHandler:
        """Get the appropriate handler for a variant ID."""
        # Check for exact match first (for service variants)
        if variant_id in self._handlers:
            return self._handlers[variant_id]

        # Check for prefix match (for training variants)
        for prefix, handler in self._handlers.items():
            if variant_id.startswith(prefix):
                return handler

        raise ValueError(f"No handler found for variant: {variant_id}")

    @classmethod
    def get_info(cls) -> Dict[str, Any]:
        """Return information about the GROBID extractor."""
        return {
            "id": "grobid-training",
            "name": "GROBID Extraction",
            "description": "Extract TEI from PDF using remote GROBID server (training data or full documents)",
            "input": ["pdf"],
            "output": ["tei-document"],
            "options": get_form_options(),
            "navigation_xpath": get_navigation_xpath(),
            "annotationGuides": get_annotation_guides()
        }

    @classmethod
    def is_available(cls) -> bool:
        """Check if GROBID server URL is configured."""
        grobid_server_url = os.environ.get("GROBID_SERVER_URL", "")
        return grobid_server_url != ""

    async def extract(self, pdf_path: Optional[str] = None, xml_content: Optional[str] = None,
                      options: Optional[Dict[str, Any]] = None) -> str:
        """
        Extract TEI from PDF using GROBID.

        Args:
            pdf_path: Path to the PDF file
            xml_content: Not used by this extractor
            options: Extraction options (doi, variant_id, flavor)

        Returns:
            Complete TEI document as XML string
        """

        # xml_content parameter required by interface but not used by this extractor
        _ = xml_content
        if not pdf_path:
            raise ValueError("PDF path is required for GROBID extraction")

        if not self.is_available():
            raise RuntimeError("GROBID extractor is not available - check GROBID_SERVER_URL environment variable")

        if options is None:
            options = {}

        # Get options for flavor and variant_id using first value from options as default
        info = self.get_info()
        default_flavor = info["options"]["flavor"]["options"][0]  # "default"
        default_variant_id = info["options"]["variant_id"]["options"][0]  # first variant

        flavor = options.get("flavor", default_flavor)
        variant_id = options.get("variant_id")
        if not variant_id:
            variant_id = default_variant_id

        # Get GROBID server info
        grobid_server_url = os.environ.get("GROBID_SERVER_URL")
        if grobid_server_url is None:
            raise ValueError("No Grobid server URL")
        grobid_version, grobid_revision = self._get_grobid_version(grobid_server_url)

        # Get the appropriate handler and fetch TEI content
        handler = self._get_handler(variant_id)
        raw_tei_content = handler.fetch_tei(pdf_path, grobid_server_url, variant_id, flavor, options)

        # Log raw GROBID response for debugging
        log_extraction_response("grobid", pdf_path, raw_tei_content, ".raw.xml")

        # Clean invalid XML attributes before parsing
        raw_tei_content = self._clean_invalid_xml_attributes(raw_tei_content)

        # Log cleaned content for debugging
        log_extraction_response("grobid", pdf_path, raw_tei_content, ".cleaned.xml")

        # Parse the GROBID output
        try:
            grobid_doc = etree.fromstring(raw_tei_content.encode('utf-8'))
        except etree.XMLSyntaxError as e:
            # Log the XML that failed to parse
            log_xml_parsing_error("grobid", pdf_path, raw_tei_content, str(e))

            # Create a minimal document structure with error info instead of failing
            # We'll use string manipulation to ensure proper CDATA formatting with unescaped XML
            import html
            escaped_error = html.escape(str(e))
            error_xml = f'''<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <text>
    <note type="error-message">{escaped_error}</note>
    <note type="invalid-xml"><![CDATA[
{raw_tei_content}
]]></note>
  </text>
</TEI>'''

            # Parse this properly constructed XML
            grobid_doc = etree.fromstring(error_xml.encode('utf-8'))

        # Create new TEI document with proper namespace (no schema validation)
        tei_doc = etree.Element("TEI", nsmap={None: "http://www.tei-c.org/ns/1.0"})  # type: ignore[dict-item]

        # Get document metadata (tries DOI lookup, falls back to extraction service)
        doi = options.get("doi", "")
        stable_id = options.get("stable_id")
        metadata = await get_metadata_for_document(doi=doi, pdf_path=pdf_path, stable_id=stable_id)

        # Create TEI header
        tei_header = create_tei_header(doi, metadata)
        assert tei_header is not None

        # Add custom elements to header
        timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

        # Add editionStmt after titleStmt with fileref
        fileDesc = tei_header.find("fileDesc")
        assert fileDesc is not None
        titleStmt = fileDesc.find("titleStmt")
        assert titleStmt is not None

        file_id = get_file_id_from_options(options, pdf_path)
        edition_stmt = create_edition_stmt_with_fileref(timestamp, "Extraction", file_id)
        titleStmt.addnext(edition_stmt)

        # Replace encodingDesc with GROBID-specific version
        existing_encodingDesc = tei_header.find("encodingDesc")
        if existing_encodingDesc is not None:
            tei_header.remove(existing_encodingDesc)

        # Create encodingDesc with PDF-TEI-Editor and GROBID applications
        encodingDesc = create_encoding_desc_with_extractor(
            timestamp=timestamp,
            extractor_name="GROBID",
            extractor_ident="GROBID",
            extractor_version=grobid_version,
            extractor_ref="https://github.com/kermitt2/grobid",
            variant_id=variant_id,
            additional_labels=[
                ("revision", grobid_revision),
                ("flavor", flavor),
            ]
        )
        tei_header.append(encodingDesc)

        # Replace revisionDesc with GROBID-specific version
        existing_revisionDesc = tei_header.find("revisionDesc")
        if existing_revisionDesc is not None:
            tei_header.remove(existing_revisionDesc)

        revision_desc = create_revision_desc_with_status(timestamp, "extraction", "Extraction")
        tei_header.append(revision_desc)

        # Add header to new document
        tei_doc.append(tei_header)

        # Extract and add the text content from GROBID output
        # Handle both with and without namespace
        grobid_text = grobid_doc.find("text")
        if grobid_text is None:
            # Try with TEI namespace (for error XML)
            grobid_text = grobid_doc.find("{http://www.tei-c.org/ns/1.0}text")

        if grobid_text is not None:
            # Check if this is an error text element (contains error notes)
            error_message_note = grobid_text.find("{http://www.tei-c.org/ns/1.0}note[@type='error-message']")
            invalid_xml_note = grobid_text.find("{http://www.tei-c.org/ns/1.0}note[@type='invalid-xml']")

            if error_message_note is not None and invalid_xml_note is not None:
                # This is an error case - recreate with proper CDATA
                new_text = etree.SubElement(tei_doc, "text")
                new_text.text = "\n    "  # Add indentation before first child

                # Add error message note
                error_note = etree.SubElement(new_text, "note", type="error-message")
                error_note.text = error_message_note.text
                error_note.tail = "\n    "  # Add indentation after this element

                # Add invalid XML note - we'll replace this with CDATA after serialization
                invalid_note = etree.SubElement(new_text, "note", type="invalid-xml")
                # Use a placeholder that we'll replace with CDATA
                invalid_note.text = "CDATA_PLACEHOLDER_FOR_INVALID_XML"
                invalid_note.tail = "\n  "  # Add indentation to close the text element
            else:
                # Normal case - copy the text element with all its content
                new_text = etree.SubElement(tei_doc, "text")
                new_text.attrib.update(grobid_text.attrib)
                new_text.text = grobid_text.text
                new_text.tail = grobid_text.tail
                for child in grobid_text:
                    new_text.append(child)
        else:
            # Fallback: create minimal text element if none found
            new_text = etree.SubElement(tei_doc, "text")
            body_elem = etree.SubElement(new_text, "body")
            div_elem = etree.SubElement(body_elem, "div")
            div_elem.set("type", "empty")
            p_elem = etree.SubElement(div_elem, "p")
            p_elem.text = "No text content available."

        # Create processing instruction for schema validation
        processing_instructions = []
        schema_url = f'https://mpilhlt.github.io/grobid-footnote-flavour/schema/{variant_id}.rng'
        schema_pi = create_schema_processing_instruction(schema_url)
        processing_instructions.append(schema_pi)

        # Serialize with selective formatting: pretty-print header but preserve text content
        result_xml = serialize_tei_with_formatted_header(tei_doc, processing_instructions)

        # Replace CDATA placeholder with actual CDATA section containing unescaped XML
        if "CDATA_PLACEHOLDER_FOR_INVALID_XML" in result_xml:
            cdata_content = f"<![CDATA[\n{raw_tei_content}\n]]>"
            result_xml = result_xml.replace("CDATA_PLACEHOLDER_FOR_INVALID_XML", cdata_content)

        return result_xml


    def _clean_invalid_xml_attributes(self, xml_content: str) -> str:
        """Clean invalid XML attributes that cause parsing errors."""
        # Fix invalid xml:id attributes like xml:id="-1"
        xml_content = re.sub(r'xml:id="-?\d+"', 'xml:id="auto-generated"', xml_content)
        return xml_content

    def _get_grobid_version(self, grobid_server_url: str) -> tuple[str, str]:
        """Get GROBID version information from the server with retry logic."""
        session = get_retry_session(retries=3, backoff_factor=2.0)
        try:
            response = session.get(f"{grobid_server_url}/api/version", timeout=30)
            response.raise_for_status()
            version_info = response.json()
            return version_info.get("version", "unknown"), version_info.get("revision", "unknown")
        except Exception as e:
            print(f"Warning: Could not fetch GROBID version: {e}")
            return "unknown", "unknown"
