"""
Reference Annotator: tags <bibl> content with bibliographic fields (author, title, date, etc.).
"""

from __future__ import annotations

import logging

from lxml import etree

from fastapi_app.plugins.tei_annotator.annotators.base import BaseAnnotator
from fastapi_app.plugins.tei_annotator.config import TEI_NS, build_references_schema
from fastapi_app.plugins.tei_annotator.utils import restore_lb

logger = logging.getLogger(__name__)


class ReferenceAnnotator(BaseAnnotator):
    """
    Sends the plain-text content of a <bibl> element to the LLM and returns
    an annotated <bibl> with child elements for author, title, date, publisher, etc.
    """

    id = "reference"
    display_name = "Reference Annotator"
    description = (
        "Tags the content of a <bibl> element with bibliographic fields: "
        "author, title, date, publisher, place of publication, etc."
    )

    def get_schema(self) -> dict:
        return build_references_schema()

    def apply_result(
        self,
        original_element: etree._Element,
        annotated_xml: str,
    ) -> list[etree._Element]:
        if not annotated_xml:
            return [original_element]

        restored = restore_lb(annotated_xml)
        try:
            parser = etree.XMLParser(recover=True)
            new_bibl = etree.fromstring(
                f'<bibl xmlns="{TEI_NS}">{restored}</bibl>'.encode("utf-8"),
                parser,
            )
            return [new_bibl]
        except etree.XMLSyntaxError as exc:
            logger.warning("tei-annotator reference: could not parse result: %s", exc)
            return [original_element]
