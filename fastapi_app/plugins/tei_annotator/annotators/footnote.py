"""
Footnote Annotator: splits a <bibl> containing multiple references into separate <bibl> elements.
"""

from __future__ import annotations

import logging

from lxml import etree

from fastapi_app.plugins.tei_annotator.annotators.base import BaseAnnotator
from fastapi_app.plugins.tei_annotator.config import TEI_NS, build_segmenter_schema
from fastapi_app.plugins.tei_annotator.utils import restore_lb

logger = logging.getLogger(__name__)


class FootnoteAnnotator(BaseAnnotator):
    """
    Uses the segmenter schema to identify individual bibliographic references within
    a single <bibl> element and returns them as a sequence of separate <bibl> elements.

    If no subdivision is possible (or the result is empty), the original element is returned.
    """

    id = "footnote"
    display_name = "Footnote Annotator"
    description = (
        "Splits a <bibl> element containing multiple references into separate <bibl> elements. "
        "If the bibl contains only one reference, it is returned unchanged."
    )

    def get_schema(self) -> dict:
        return build_segmenter_schema()

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
            wrapper = etree.fromstring(
                f'<listBibl xmlns="{TEI_NS}">{restored}</listBibl>'.encode("utf-8"),
                parser,
            )
            bibls = wrapper.findall(f"{{{TEI_NS}}}bibl")
            if bibls:
                return bibls
        except etree.XMLSyntaxError as exc:
            logger.warning("tei-annotator footnote: could not parse result: %s", exc)

        return [original_element]
