"""
TEI Annotator extraction engine (DISABLED — kept for reference only).

This module is no longer imported or registered. The plugin now uses a standalone
annotators/ package and routes.py instead of the BaseExtractor integration.
Several imports below will fail if this module is loaded directly, as constants and
helpers have been moved to config.py / utils.py.

Re-annotates GROBID training documents using LLM inference via the
TEI Annotator webservice (/api/annotate). Supports two training variants:

- grobid.training.references: tags <bibl> content with author, title, etc.
- grobid.training.references.referenceSegmenter: segments <listBibl> into <bibl> elements
"""

from __future__ import annotations

import asyncio
import datetime
import logging
from typing import Any, Dict, Optional

import requests
from lxml import etree

from fastapi_app.lib.extraction import BaseExtractor
from fastapi_app.lib.services.metadata_extraction import get_metadata_for_document
from fastapi_app.lib.utils.config_utils import get_config
from fastapi_app.lib.utils.tei_utils import (
    create_edition_stmt_with_fileref,
    create_encoding_desc_with_extractor,
    create_revision_desc_with_status,
    create_schema_processing_instruction,
    create_tei_header,
    extract_tei_metadata,
    get_file_id_from_options,
    serialize_tei_with_formatted_header,
)
from fastapi_app.plugins.tei_annotator.config import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_MODEL,
    DEFAULT_PROVIDER,
    LB_PLACEHOLDER,
    SCHEMA_URL_REFERENCES,
    SCHEMA_URL_SEGMENTER,
    TEI_BIBL,
    TEI_LB,
    TEI_NS,
    TEI_NSMAP,
    VARIANT_REFERENCES,
    VARIANT_SEGMENTER,
    bibl_to_plain_text,
    build_references_schema,
    build_segmenter_schema,
    element_to_plain_text_with_lb,
    restore_lb,
)

logger = logging.getLogger(__name__)


class TeiAnnotatorExtractor(BaseExtractor):
    """
    LLM-based re-annotation of GROBID training documents via the TEI Annotator webservice.
    """

    # Populated at plugin initialize() time by _load_providers().
    # Format: [{"id": "gemini", "models": ["gemini-2.5-flash", ...]}, ...]
    _providers: list[dict] = [{"id": DEFAULT_PROVIDER, "models": [DEFAULT_MODEL]}]

    # -------------------------------------------------------------------------
    # Class-level provider caching
    # -------------------------------------------------------------------------

    @classmethod
    def _load_providers(cls) -> None:
        """
        Fetch available providers and models from the TEI Annotator service.
        Populates _providers; falls back silently to the hardcoded default on any error.
        """
        config = get_config()
        server_url = config.get("tei-annotator.server.url")
        if not server_url:
            return

        api_key = config.get("tei-annotator.server.api-key")
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

        try:
            resp = requests.get(
                f"{server_url.rstrip('/')}/api/config",
                headers=headers,
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()
            providers = data.get("providers", [])
            if providers:
                cls._providers = [
                    {"id": p["id"], "models": p.get("models", [p.get("default_model", DEFAULT_MODEL)])}
                    for p in providers
                ]
                logger.info("tei-annotator: loaded %d providers from service", len(cls._providers))
        except Exception as exc:
            logger.warning("tei-annotator: could not fetch provider list: %s", exc)

    # -------------------------------------------------------------------------
    # BaseExtractor interface
    # -------------------------------------------------------------------------

    @classmethod
    def _get_model_groups(cls) -> list[dict]:
        """Return provider-grouped model list for the UI (groups format)."""
        return [
            {"label": p["id"], "options": p["models"]}
            for p in cls._providers
        ]

    @classmethod
    def get_info(cls) -> Dict[str, Any]:
        """Return extractor metadata including dynamic provider/model options."""
        return {
            "id": "tei-annotator",
            "name": "TEI Annotator (LLM)",
            "description": (
                "Re-annotates GROBID training documents using LLM inference via the "
                "TEI Annotator webservice"
            ),
            "input": ["xml"],
            "output": ["tei-document"],
            "options": {
                "variant_id": {
                    "type": "string",
                    "label": "Variant",
                    "options": [VARIANT_REFERENCES, VARIANT_SEGMENTER],
                },
                "model": {
                    "type": "string",
                    "label": "Model",
                    "groups": cls._get_model_groups(),
                },
                "batch_size": {
                    "type": "string",
                    "label": "Batch size",
                    "description": "Number of <bibl> elements per LLM call",
                    "options": ["1", "3", "5", "10"],
                    "depends": {"variant_id": VARIANT_REFERENCES},
                },
            },
        }

    @staticmethod
    def _parse_provider_model(model_value: str) -> tuple[str, str]:
        """
        Split a combined "provider/model" option value into (provider, model).

        Falls back to (DEFAULT_PROVIDER, model_value) if no slash is present.
        """
        if "/" in model_value:
            provider, _, model = model_value.partition("/")
            return provider, model
        return DEFAULT_PROVIDER, model_value

    @classmethod
    def is_available(cls) -> bool:
        """Available when the server URL is configured."""
        return bool(get_config().get("tei-annotator.server.url"))

    async def extract(
        self,
        pdf_path: Optional[str] = None,
        xml_content: Optional[str] = None,
        options: Optional[Dict[str, Any]] = None,
    ) -> str:
        """
        Re-annotate a GROBID training TEI document.

        Args:
            pdf_path: Not used (XML-only extractor).
            xml_content: Source TEI document as string.
            options: Extraction options. Relevant keys:
                variant_id, provider, model, batch_size, doi, stable_id.

        Returns:
            New TEI document as XML string with LLM annotations.
        """
        _ = pdf_path  # not used
        if not xml_content:
            raise ValueError("xml_content is required for tei-annotator extraction")
        if options is None:
            options = {}

        variant_id = options.get("variant_id", VARIANT_REFERENCES)

        try:
            root = etree.fromstring(xml_content.encode("utf-8"))
        except etree.XMLSyntaxError as exc:
            raise ValueError(f"Could not parse source XML: {exc}") from exc

        if variant_id == VARIANT_REFERENCES:
            return await self._annotate_references(root, options)
        if variant_id == VARIANT_SEGMENTER:
            return await self._annotate_segmenter(root, options)
        raise ValueError(f"Unsupported variant_id: {variant_id!r}")

    # -------------------------------------------------------------------------
    # Variant-specific annotation
    # -------------------------------------------------------------------------

    async def _annotate_references(
        self, root: etree._Element, options: Dict[str, Any]
    ) -> str:
        """
        Annotate <bibl> elements in a grobid.training.references document.

        Strips existing annotations, sends plain text to /api/annotate in batches,
        and reconstructs annotated <bibl> elements.
        """
        list_bibl = root.find(".//tei:text//tei:listBibl", TEI_NSMAP)
        if list_bibl is None:
            raise ValueError("No <listBibl> element found in the source TEI document")

        bibl_elements = list_bibl.findall("tei:bibl", TEI_NSMAP)
        if not bibl_elements:
            raise ValueError("No <bibl> elements found inside <listBibl>")

        plain_texts = [bibl_to_plain_text(b) for b in bibl_elements]

        provider, model = self._parse_provider_model(
            options.get("model", f"{DEFAULT_PROVIDER}/{DEFAULT_MODEL}")
        )
        batch_size = int(options.get("batch_size", DEFAULT_BATCH_SIZE))

        results = await self._call_annotate(
            texts=plain_texts,
            schema=build_references_schema(),
            batch_size=batch_size,
            provider=provider,
            model=model,
        )

        # Rebuild bibl elements from annotated results
        new_bibl_elements: list[etree._Element] = []
        for original_bibl, result in zip(bibl_elements, results):
            annotated_xml = (result or {}).get("xml", "")
            if annotated_xml:
                new_bibl = self._parse_annotated_bibl(annotated_xml, original_bibl)
            else:
                # Keep original on failure; add a visible comment
                new_bibl = original_bibl
                new_bibl.append(
                    etree.Comment(" tei-annotator: annotation failed — original content preserved ")
                )
            new_bibl_elements.append(new_bibl)

        # Replace listBibl children
        for child in list(list_bibl):
            list_bibl.remove(child)
        for new_bibl in new_bibl_elements:
            list_bibl.append(new_bibl)

        return await self._build_output_tei(root, list_bibl, VARIANT_REFERENCES, options, provider, model)

    async def _annotate_segmenter(
        self, root: etree._Element, options: Dict[str, Any]
    ) -> str:
        """
        Re-segment <listBibl> content in a grobid.training.references.referenceSegmenter document.

        Strips all existing tags (including <bibl>) and sends flat text to /api/annotate,
        which returns a new set of <bibl> segments.
        """
        list_bibls = root.findall(".//tei:text//tei:listBibl", TEI_NSMAP)
        if not list_bibls:
            raise ValueError("No <listBibl> element found in the source TEI document")

        provider, model = self._parse_provider_model(
            options.get("model", f"{DEFAULT_PROVIDER}/{DEFAULT_MODEL}")
        )

        for list_bibl in list_bibls:
            flat_text = element_to_plain_text_with_lb(list_bibl)
            results = await self._call_annotate(
                text=flat_text,
                schema=build_segmenter_schema(),
                provider=provider,
                model=model,
            )
            annotated_xml = (results[0] or {}).get("xml", "") if results else ""
            if not annotated_xml:
                list_bibl.append(
                    etree.Comment(" tei-annotator: segmentation failed — original content preserved ")
                )
                continue

            new_bibl_elements = self._parse_segmented_bibls(annotated_xml)
            for child in list(list_bibl):
                list_bibl.remove(child)
            for new_bibl in new_bibl_elements:
                list_bibl.append(new_bibl)

        return await self._build_output_tei(root, None, VARIANT_SEGMENTER, options, provider, model)

    # -------------------------------------------------------------------------
    # HTTP call to annotation service
    # -------------------------------------------------------------------------

    async def _call_annotate(
        self,
        *,
        text: Optional[str] = None,
        texts: Optional[list[str]] = None,
        schema: dict,
        batch_size: int = 1,
        provider: str,
        model: str,
    ) -> list[dict]:
        """
        POST to /api/annotate and return a list of response dicts.

        Args:
            text: Single text for single-item annotation.
            texts: List of texts for batch annotation.
            schema: TEI annotation schema dict.
            batch_size: Number of texts per LLM call (batch mode only).
            provider: Provider id (e.g. "gemini").
            model: Model id (e.g. "gemini-2.5-flash").

        Returns:
            List of response dicts with "xml", "fuzzy_spans", "elapsed_seconds" keys.
        """
        config = get_config()
        server_url = config.get("tei-annotator.server.url")
        if not server_url:
            raise RuntimeError("tei-annotator.server.url is not configured")

        url = f"{server_url.rstrip('/')}/api/annotate"
        api_key = config.get("tei-annotator.server.api-key")
        headers: dict[str, str] = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        body: dict[str, Any] = {
            "provider": provider,
            "model": model,
            "schema": schema,
        }
        if texts is not None:
            body["texts"] = texts
            body["batch_size"] = batch_size
        else:
            body["text"] = text

        def _do_post() -> list[dict]:
            resp = requests.post(url, json=body, headers=headers, timeout=300)
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, list) else [data]

        return await asyncio.to_thread(_do_post)

    # -------------------------------------------------------------------------
    # XML reconstruction helpers
    # -------------------------------------------------------------------------

    def _parse_annotated_bibl(
        self, annotated_xml: str, original_bibl: etree._Element
    ) -> etree._Element:
        """
        Build a new <bibl> element from the annotated XML fragment returned by /api/annotate.

        Restores lb placeholders and wraps the fragment in <bibl> for parsing.
        Falls back to the original element on parse error.
        """
        restored = restore_lb(annotated_xml)
        try:
            parser = etree.XMLParser(recover=True)
            wrapper = etree.fromstring(
                f'<bibl xmlns="{TEI_NS}">{restored}</bibl>'.encode("utf-8"),
                parser,
            )
            return wrapper
        except etree.XMLSyntaxError as exc:
            logger.warning("tei-annotator: could not parse annotated bibl fragment: %s", exc)
            original_bibl.append(
                etree.Comment(f" tei-annotator: parse error — original preserved: {exc} ")
            )
            return original_bibl

    def _parse_segmented_bibls(self, annotated_xml: str) -> list[etree._Element]:
        """
        Parse the /api/annotate response for the segmenter variant.

        The service returns the inner content of <listBibl> (a sequence of <bibl> elements
        and plain text). Returns the list of <bibl> child elements found.
        """
        restored = restore_lb(annotated_xml)
        try:
            parser = etree.XMLParser(recover=True)
            wrapper = etree.fromstring(
                f'<listBibl xmlns="{TEI_NS}">{restored}</listBibl>'.encode("utf-8"),
                parser,
            )
            return wrapper.findall(f"{{{TEI_NS}}}bibl")
        except etree.XMLSyntaxError as exc:
            logger.warning("tei-annotator: could not parse segmented listBibl fragment: %s", exc)
            return []

    # -------------------------------------------------------------------------
    # TEI output builder
    # -------------------------------------------------------------------------

    async def _build_output_tei(
        self,
        original_root: etree._Element,
        updated_list_bibl: Optional[etree._Element],
        variant_id: str,
        options: Dict[str, Any],
        provider: str,
        model: str,
    ) -> str:
        """
        Construct and serialize the output TEI document.

        Copies the <text> structure from *original_root* (which already has its
        <listBibl> children updated in place), then rebuilds the teiHeader with
        fresh extractor metadata.
        """
        timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

        # Extract doi and metadata from the source document
        source_metadata = extract_tei_metadata(original_root)
        doi = source_metadata.get("doi", "") or options.get("doi", "")
        stable_id = options.get("stable_id")
        metadata = await get_metadata_for_document(doi=doi, stable_id=stable_id)

        # Build new TEI root
        tei_doc = etree.Element("TEI", nsmap={None: TEI_NS})  # type: ignore[dict-item]

        # Build teiHeader
        tei_header = create_tei_header(doi, metadata)
        assert tei_header is not None

        file_desc = tei_header.find("fileDesc")
        assert file_desc is not None
        title_stmt = file_desc.find("titleStmt")
        assert title_stmt is not None

        file_id = get_file_id_from_options(options)
        edition_stmt = create_edition_stmt_with_fileref(timestamp, "LLM Annotation", file_id)
        title_stmt.addnext(edition_stmt)

        existing_encoding_desc = tei_header.find("encodingDesc")
        if existing_encoding_desc is not None:
            tei_header.remove(existing_encoding_desc)

        schema_url = SCHEMA_URL_REFERENCES if variant_id == VARIANT_REFERENCES else SCHEMA_URL_SEGMENTER
        encoding_desc = create_encoding_desc_with_extractor(
            timestamp=timestamp,
            extractor_name="TEI Annotator",
            extractor_ident="tei-annotator",
            extractor_version="1.0.0",
            variant_id=variant_id,
            additional_labels=[
                ("provider", provider),
                ("model", model),
            ],
            refs=["https://github.com/mpilhlt/tei-annotator", schema_url],
        )
        tei_header.append(encoding_desc)

        existing_revision_desc = tei_header.find("revisionDesc")
        if existing_revision_desc is not None:
            tei_header.remove(existing_revision_desc)
        tei_header.append(create_revision_desc_with_status(timestamp, "extraction", "LLM annotation"))

        tei_doc.append(tei_header)

        # Attach the (already mutated) <text> element from the original document
        original_text = original_root.find(f"{{{TEI_NS}}}text")
        if original_text is None:
            original_text = original_root.find("text")
        if original_text is not None:
            tei_doc.append(original_text)
        else:
            logger.warning("tei-annotator: no <text> element found in source document")

        schema_pi = create_schema_processing_instruction(schema_url)
        return serialize_tei_with_formatted_header(tei_doc, [schema_pi])
