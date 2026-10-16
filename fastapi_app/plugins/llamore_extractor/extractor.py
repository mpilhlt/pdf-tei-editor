"""
LLamore-based reference extraction engine.
"""

import asyncio
from typing import Dict, Any, Optional
import logging
from pathlib import Path
from lxml import etree

from fastapi_app.lib.extraction import BaseExtractor
from fastapi_app.lib.llm import LLMProvider, LLMProviderRegistry, get_default_model
from fastapi_app.lib.llm.model_access import check_model_access
from fastapi_app.lib.services.metadata_extraction import get_metadata_for_document
from fastapi_app.lib.utils.tei_utils import (
    create_tei_document,
    create_tei_header,
    create_revision_desc_with_status,
    create_schema_processing_instruction,
    serialize_tei_with_formatted_header,
    get_file_id_from_options,
    create_encoding_desc_with_extractor,
)
from fastapi_app.lib.utils.doi_utils import encode_for_xml_id
from fastapi_app.lib.utils.debug_utils import log_extraction_response, log_xml_parsing_error
from fastapi_app.lib.utils.config_utils import get_config
from fastapi_app.lib.core.dependencies import get_auth_manager, get_db, get_document_rules_store
from fastapi_app.lib.doc_rules.extraction_contribution import ExtractionFragment, for_extraction
from fastapi_app.lib.utils.annotation_rules_utils import AnnotationRuleRef
from .config import (
    get_annotation_guides,
    get_form_options,
    get_navigation_xpath,
    get_schema_url,
    get_supported_variants,
)
import datetime

logger = logging.getLogger(__name__)

ADDITIONAL_INSTRUCTIONS_URL = (
    "https://github.com/mpilhlt/pdf-tei-editor/blob/main/"
    "fastapi_app/plugins/llamore_extractor/prompts/additional-instructions.md"
)

# Kept as the extractor id (rather than renamed to "llamore") so stored
# configs, batch scripts and client defaults that name it keep working;
# the extractor itself is no longer tied to Gemini.
EXTRACTOR_ID = "llamore-gemini"

NO_MODEL_MESSAGE = "No LLM model selected for LLamore extraction. Choose one under Tools > Default Model."

from llamore import LineByLinePrompter, TeiBiblStruct  # type: ignore[import-untyped]


class LLamoreExtractor(BaseExtractor):
    """
    LLamore-based reference extraction from PDF files.

    Inference runs through the general LLM provider registry
    (fastapi_app/lib/llm/), using the provider/model passed in the options
    (the client sends the model chosen under Tools > Default Model) or else
    the installation-wide default model. LLamore only supplies the prompter
    and the TEI serialization. Providers that accept PDF input get the PDF
    itself; for the others the PDF's text layer is sent instead.
    """

    @classmethod
    def get_info(cls) -> Dict[str, Any]:
        """Return information about the LLamore extractor."""
        return {
            "id": EXTRACTOR_ID,
            "name": "LLamore",
            "description": "Extract bibliographic references from PDF using the LLamore library with the configured LLM model",
            "input": ["pdf"],
            "output": ["tei-document"],
            "uses_inference_model": True,
            "variants": get_supported_variants(),
            "options": get_form_options(),
            "navigation_xpath": get_navigation_xpath(),
            "annotationGuides": get_annotation_guides()
        }

    @classmethod
    def is_available(cls) -> bool:
        """Available when at least one LLM provider is registered and usable."""
        return bool(LLMProviderRegistry.get_instance().list_providers(available_only=True))

    @staticmethod
    def _resolve_model(options: Dict[str, Any]) -> tuple[LLMProvider, str]:
        """
        The provider and model to extract with: `provider_id`/`model_id` from
        the options if given, else the configured default model. Raises
        ValueError when neither is set or the provider is unknown, and
        ModelAccessDenied when the requesting user may not use the model.
        """
        provider_id = options.get("provider_id")
        model_id = options.get("model_id")
        if not (provider_id and model_id):
            default = get_default_model()
            if default is None:
                raise ValueError(NO_MODEL_MESSAGE)
            provider_id, model_id = default
        try:
            provider = LLMProviderRegistry.get_instance().get_provider(provider_id)
        except KeyError as e:
            raise ValueError(f"LLM provider '{provider_id}' is not available. {NO_MODEL_MESSAGE}") from e
        username = options.get("username")
        user = get_auth_manager().get_user_by_username(username) if username else None
        check_model_access(provider, model_id, user)
        return provider, model_id

    async def extract(self, pdf_path: Optional[str] = None, xml_content: Optional[str] = None,
                      options: Optional[Dict[str, Any]] = None) -> str:
        """
        Extract references from PDF using LLamore.

        Args:
            pdf_path: Path to the PDF file
            xml_content: Not used by this extractor
            options: Extraction options (doi, username, ...)

        Returns:
            Complete TEI document as XML string
        """
        if not pdf_path:
            raise ValueError("PDF path is required for LLamore extraction")

        if not self.is_available():
            raise RuntimeError("LLamore extractor is not available - no LLM provider is configured")

        if options is None:
            options = {}

        provider, model_id = self._resolve_model(options)

        username = options.get("username")
        additional_instructions, editorial_decl_entries = self._resolve_additional_instructions(username)

        # Create TEI document
        tei_doc = create_tei_document()

        # Get document metadata (tries DOI lookup, falls back to extraction service)
        doi = options.get("doi", "")
        stable_id = options.get("stable_id")
        metadata = await get_metadata_for_document(doi=doi, pdf_path=pdf_path, stable_id=stable_id)

        # Create basic TEI header
        tei_header = create_tei_header(doi, metadata)
        assert tei_header is not None

        timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        file_id = get_file_id_from_options(options, pdf_path)

        fileDesc = tei_header.find("fileDesc")
        assert fileDesc is not None

        # Set xml:id on fileDesc for document identity (NCName-safe encoding)
        fileDesc.set("{http://www.w3.org/XML/1998/namespace}id", encode_for_xml_id(file_id))

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
                ("provider", provider.label),
                ("model", model_id),
            ],
            refs=[
                "https://github.com/mpilhlt/llamore",
                schema_url,
            ],
            editorial_decl_entries=editorial_decl_entries,
        )
        tei_header.append(encodingDesc)

        # Replace revisionDesc with LLamore-specific version
        existing_revisionDesc = tei_header.find("revisionDesc")
        if existing_revisionDesc is not None:
            tei_header.remove(existing_revisionDesc)

        extraction_label = get_config().get('annotation.lifecycle.change-descriptions', default=["Extraction"])[0]
        revision_desc = create_revision_desc_with_status(timestamp, "extraction", "Generated with LLamore", label=extraction_label)
        tei_header.append(revision_desc)

        tei_doc.append(tei_header)

        # Extract references
        listBibl = await self._extract_refs_from_pdf(pdf_path, provider, model_id, additional_instructions_text=additional_instructions)

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

    def _resolve_additional_instructions(self, username: Optional[str]) -> tuple[str, list[AnnotationRuleRef]]:
        """
        Resolve the "additional instructions" fragment via for_extraction():
        the text to feed the prompter (the user's selected override, if
        any, else the shipped default) and the one editorialDecl entry
        documenting it.

        The entry has only a "human" ref, no "machine" ref. With no
        override selected for this resource, annotation_review/
        review_logic.py's gather_rule_excerpts() requires a "machine" ref
        to fetch from and so skips this category - these are
        extraction-time instructions, not an annotation guide, and were
        never meant to reach the review LLM's prompt in that case. But if
        a user *does* select an override for this resource (exactly the
        feature this mechanism exists to offer), gather_rule_excerpts()'s
        override short-circuit surfaces it anyway, ahead of the
        machine-ref requirement - not excluded categorically, only when
        unoverridden. See gather_rule_excerpts()'s own docstring.

        for_extraction() is called with exactly one descriptor, so
        `fragments[0]` is safe; if a second descriptor is ever added here,
        this indexing must be updated to iterate accordingly.
        """
        store = get_document_rules_store(get_db())
        fragments = for_extraction(username, [
            ExtractionFragment(
                url=ADDITIONAL_INSTRUCTIONS_URL,
                file=Path(__file__).parent / "prompts" / "additional-instructions.md",
                label="Reference extraction instructions",
            ),
        ], store)
        fragment = fragments[0]
        editorial_decl_entries: list[AnnotationRuleRef] = [{
            "category": "additional-instructions",
            "n": fragment.label,
            "refs": [{
                "target": fragment.url_pinned,
                "content_type": "markdown",
                "subtype": "human",
            }],
        }]
        return fragment.text, editorial_decl_entries

    async def _extract_refs_from_pdf(self, pdf_path: str, provider: LLMProvider, model_id: str, additional_instructions_text: str) -> etree._Element:  # type: ignore[name-defined]
        """Extract references from PDF using LLamore's prompter with the given LLM provider/model."""
        logger.info("Extracting references from %s via LLamore/%s/%s", pdf_path, provider.id, model_id)

        # Named "_text" (not "additional_instructions") so it isn't shadowed
        # by user_prompt()'s own same-named parameter below, which llamore's
        # LineByLinePrompter base class defines and this override extends.
        class CustomPrompter(LineByLinePrompter):
            def user_prompt(self, text=None, additional_instructions="") -> str:
                if additional_instructions_text:
                    additional_instructions += "In particular, follow these rules:\n\n" + additional_instructions_text
                return super().user_prompt(text, additional_instructions)

        prompter = CustomPrompter()
        if provider.supports_pdf_input(model_id):
            response = await provider.chat_completion_with_pdf(
                model_id, prompter.system_prompt(), prompter.user_prompt(), pdf_path
            )
        else:
            text = await asyncio.to_thread(_pdf_text, pdf_path)
            if not text.strip():
                raise ValueError(f"The PDF has no text layer, and LLM provider '{provider.label}' does not accept PDF input")
            response = await provider.chat_completion(model_id, prompter.system_prompt(), prompter.user_prompt(text=text))
        references = prompter.parse(response)
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


def _pdf_text(pdf_path: str) -> str:
    """The PDF's text layer, page by page."""
    from pypdf import PdfReader

    reader = PdfReader(pdf_path)
    return "\n\n".join((page.extract_text() or "") for page in reader.pages)
