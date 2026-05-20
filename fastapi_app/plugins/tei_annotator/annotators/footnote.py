"""
Footnote Annotator: splits a <bibl> containing multiple references into separate <bibl> elements.
"""

from __future__ import annotations

import logging

from lxml import etree

from tei_annotator.schemas.bibl_reference_segmenter import build_schema
from fastapi_app.plugins.tei_annotator.annotators.base import BaseAnnotator
from fastapi_app.plugins.tei_annotator.config import TEI_NS
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
    target_variants = [
        "grobid.training.references.referenceSegmenter",
        "llamore-default",
    ]

    def get_schema(self) -> dict:
        """Return the annotation schema dict sent to the webservice."""
        return build_schema().to_dict()

    def apply_result(
        self,
        original_element: etree._Element,
        annotated_xml: str,
    ) -> list[etree._Element | str]:
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
                # Re-attach orphaned lb siblings to the immediately preceding bibl.
                # inject_xml places <lb/> outside a bibl span when the LLM's span
                # boundary falls before the lb; findall("bibl") would otherwise lose it.
                prev_bibl = None
                for child in list(wrapper):
                    local = etree.QName(child.tag).localname if isinstance(child.tag, str) else None
                    if local == "bibl":
                        prev_bibl = child
                    elif local == "lb" and prev_bibl is not None:
                        prev_bibl.append(child)
                # Serialize the full inner content of the wrapper, preserving any
                # text nodes (bare text between or before bibl spans) alongside the
                # bibl elements, so nothing is silently discarded.
                parts: list[str] = []
                if wrapper.text:
                    parts.append(wrapper.text)
                for child in wrapper:
                    local = etree.QName(child.tag).localname if isinstance(child.tag, str) else None
                    if local == "bibl":
                        first = next(iter(child), None)
                        first_local = etree.QName(first.tag).localname if first is not None and isinstance(first.tag, str) else None
                        if first_local == "label":
                            parts.append("\n")
                    parts.append(etree.tostring(child, encoding="unicode", with_tail=True))
                return ["".join(parts)]
        except etree.XMLSyntaxError as exc:
            logger.warning("tei-annotator footnote: could not parse result: %s", exc)

        return [original_element]
