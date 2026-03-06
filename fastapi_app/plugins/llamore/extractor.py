"""
LLamore-based reference extraction engine.
"""

import os
from typing import Dict, Any, Optional
from lxml import etree

from fastapi_app.lib.extraction import BaseExtractor
from fastapi_app.lib.services.metadata_extraction import get_metadata_for_document
from fastapi_app.lib.utils.tei_utils import (
    create_tei_document,
    create_tei_header,
    create_revision_desc_with_status,
    create_schema_processing_instruction,
    serialize_tei_with_formatted_header,
    get_file_id_from_options,
    create_edition_stmt_with_fileref,
    create_encoding_desc_with_extractor,
)
from fastapi_app.lib.utils.debug_utils import log_extraction_response, log_xml_parsing_error
from fastapi_app.plugins.llamore.config import (
    get_annotation_guides,
    get_form_options,
    get_navigation_xpath,
    get_schema_url,
)
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
            "options": get_form_options(),
            "navigation_xpath": get_navigation_xpath(),
            "annotationGuides": get_annotation_guides()
        }

    @classmethod
    def is_available(cls) -> bool:
        """Check if LLamore and Gemini API key are available."""
        if not LLAMORE_AVAILABLE:
            return False

        gemini_api_key = os.environ.get("GEMINI_API_KEY", "")
        return gemini_api_key != ""

    async def extract(self, pdf_path: Optional[str] = None, xml_content: Optional[str] = None,
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

        # Get document metadata (tries DOI lookup, falls back to extraction service)
        doi = options.get("doi", "")
        stable_id = options.get("stable_id")
        metadata = await get_metadata_for_document(doi=doi, pdf_path=pdf_path, stable_id=stable_id)

        # Create basic TEI header
        tei_header = create_tei_header(doi, metadata)
        assert tei_header is not None

        # Add editionStmt with fileref
        timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        file_id = get_file_id_from_options(options, pdf_path)

        fileDesc = tei_header.find("fileDesc")
        assert fileDesc is not None
        titleStmt = fileDesc.find("titleStmt")
        assert titleStmt is not None

        edition_stmt = create_edition_stmt_with_fileref(timestamp, "Extraction", file_id)
        titleStmt.addnext(edition_stmt)

        # Create encodingDesc with applications
        existing_encodingDesc = tei_header.find("encodingDesc")
        if existing_encodingDesc is not None:
            tei_header.remove(existing_encodingDesc)

        # Get variant_id from options using first value as default
        info = self.get_info()
        default_variant_id = info["options"]["variant_id"]["options"][0]  # "llamore-default"
        variant_id = options.get("variant_id", default_variant_id)

        schema_url = get_schema_url(variant_id)
        encodingDesc = create_encoding_desc_with_extractor(
            timestamp=timestamp,
            extractor_name="LLamore",
            extractor_ident="llamore",
            extractor_version="1.0",
            variant_id=variant_id,
            additional_labels=[
                ("prompter", "LineByLinePrompter"),
            ],
            refs=[
                "https://github.com/mpilhlt/llamore",
                schema_url,
            ],
        )
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
