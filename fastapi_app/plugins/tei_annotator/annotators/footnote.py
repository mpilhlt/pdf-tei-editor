"""
Footnote Annotator: splits a <bibl> containing multiple references into separate <bibl> elements.
"""

from __future__ import annotations

import logging

from lxml import etree

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

    def get_schema(self) -> dict:
        """
        Return the annotation schema for segmenting text into individual <bibl> references.

        The LLM receives plain text and must identify spans corresponding to individual
        bibliographic references. Labels (footnote numbers) are identified as nested spans.
        """
        return {
            "elements": [
                {
                    "tag": "bibl",
                    "description": (
                        "A span covering one complete bibliographic reference, including any "
                        "commentary that directly qualifies or elaborates on that specific reference. "
                        "Commentary that immediately precedes a reference (e.g. 'See also', "
                        "'For a different view see', 'Cf.') and belongs to it must be included in "
                        "the span. Commentary that immediately follows a reference and is clearly "
                        "about that reference (e.g. '(arguing that ...)', 'who first demonstrated "
                        "that ...') must also be included. "
                        "A 'bibl' span must contain at minimum one verifiable bibliographic item — "
                        "author name, title, publication, or a short-form citation ('Ibid.', 'op. cit.', "
                        "a bare page number following a prior citation). "
                        "Sources that have no authors, such as websites (typically consisting of a title "
                        "and a url) are also individual bibliographic references. "
                        "Do not include commentary that stands completely on its own, refers to "
                        "no specific reference, or bridges two different references."
                    ),
                    "allowed_children": ["label"],
                    "attributes": [],
                },
                {
                    "tag": "label",
                    "description": (
                        "A numeric or alphanumeric label at the start of a reference that identifies "
                        "or numbers it. Typical forms: a plain number ('17'), a number with a "
                        "trailing period ('17.'), a number in square brackets ('[77]', '[ACL30]'), "
                        "or a letter-number code ('5a'). The separator after the label (period, "
                        "dash, space) is NOT part of the label. "
                        "A label is always a number or short code at the very beginning of a "
                        "reference — never a word, name, or sentence fragment."
                    ),
                    "allowed_children": [],
                    "attributes": [],
                },
            ],
            "rules": [
                "CRITICAL RULES:\n"
                " - Mark each distinct bibliographic reference as a 'bibl' span. Typically, if a sequence ",
                "contains more than one reference, they are separated by a semicolon or a period, but "
                "there are exceptions to that convention and they might not apply in every language.\n"
                " - When a reference begins with a number or short code that labels it, mark that "
                "label as a 'label' span nested inside the 'bibl' span."
                " - A phrase that contains no bibliographic content must NOT be marked as a 'bibl' span unless it is"
                "a commentary on a previous or following reference.\n"
                " - There should never be two distinct bibliographic references in one span, always emit one"
                "span for each reference\n"
                " - span coverage: `bibl` spans are contigous, do not leave any text or whitespace outside of the spans.\n"
                " - separators: include separators such as semicolon or periods in the last `bibl` span\n"
                " — commentary inclusion: Take extra care when deciding whether adjacent "
                "commentary belongs to a reference. Commentary directly before a reference belongs "
                "to it if it introduces, qualifies, or directs the reader specifically to that "
                "reference (e.g. 'See', 'Cf.', 'For a contrary view, see'). Commentary directly "
                "after a reference belongs to it if it elaborates on or evaluates that specific "
                "source (e.g. parenthetical remarks, brief paraphrases). When commentary appears "
                "between two references, carefully determine which reference it modifies — include "
                "it in the span of the reference it belongs to, or leave it unspanned if it is "
                "genuinely standalone. Completely standalone commentary — general remarks unattached "
                "reference, topic sentences, section headings — must NOT be included in any "
                "to any single  'bibl' span.\n",
                "- labels: Make sure to recognize 'label' spans at the beginning of the sequence. ",
                "Do not nest 'bibl' spans inside other 'bibl' spans. \n",
                "- Preserve all original whitespace and punctuation within spans.\n",
            ],
        }

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
