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
                    "description": "A span covering one complete bibliographic reference, including any commentary that directly qualifies or elaborates on that specific reference. Commentary that immediately precedes a reference (e.g. 'See also', 'For a different view see', 'Cf.', and similar expressions in other languages, such as 'siehe auch', 'ver tabém') and belongs to it must be included in the span. Commentary that immediately follows a reference and is clearly about that reference (e.g. '(arguing that ...)', 'who first demonstrated that ...') must also be included. A 'bibl' span must contain at minimum one verifiable bibliographic item — author name, title, publication, or a short-form citation ('Ibid.', 'op. cit.', a bare page number following a prior citation). Sources that have no authors, such as websites (typically consisting of a title and a url) are also individual bibliographic references. Do not include commentary that stands completely on its own, refers to no specific reference, or bridges two different references.",
                    "allowed_children": ["label"],
                    "attributes": [],
                },
                {
                    "tag": "label",
                    "description": "A numeric or alphanumeric label at the start of a reference that identifies or numbers it. Typical forms: a plain number ('17'), a number with a trailing period ('17.'), a number in square brackets ('[77]', '[ACL30]'), or a letter-number code ('5a'). The separator after the label (period, dash, space) is NOT part of the label. A label is always a number or short code at the very beginning of a reference — never a word, name, or sentence fragment.",
                    "allowed_children": [],
                    "attributes": [],
                },
            ],
            "rules": [
                "CRITICAL RULES:",
                "Mark each distinct bibliographic reference as a 'bibl' span. A new reference typically begins with an author's last name (often in ALL-CAPS or inverted 'SURNAME, First' form) or with an introductory phrase such as 'Cf.', 'See', 'Ver também:', 'Nesse sentido:', 'Ibidem', 'op. cit.'.",
                "References within a footnote are most commonly separated by a semicolon followed by a new author name, or by a period followed by a new author name in inverted/capitalised form. A semicolon that appears *within* an author list (e.g. 'COIMBRA, Marcelo; Manzi, Vanessa') is NOT a reference separator — it separates co-authors of the same work.",
                "When a reference begins with a number or short code that labels it, mark that label as a 'label' span nested inside the 'bibl' span.",
                "There must never be two distinct bibliographic references inside one 'bibl' span; emit one span per reference.",
                "Include the trailing separator of each reference (the semicolon or period that terminates it) inside that reference's 'bibl' span, not at the start of the next one.",
                "Introductory commentary that immediately precedes a reference and directs the reader to it (e.g. 'See', 'Cf.', 'Nesse sentido:', 'For a contrary view, see') belongs inside that reference's 'bibl' span. When such commentary introduces two or more consecutive references, attach it to the immediately following reference.",
                "Commentary that immediately follows a reference and elaborates on it (e.g. parenthetical remarks, brief paraphrases) belongs inside that reference's 'bibl' span.",
                "Truly standalone commentary — general remarks unattached to any single reference, topic sentences, section headings — must NOT be forced into a 'bibl' span. Leave it outside all spans rather than misattributing it.",
                "Cover as much of the text as possible with 'bibl' spans. Do not leave whitespace or punctuation between spans unless it is genuinely standalone commentary.",
                "Do not nest 'bibl' spans inside other 'bibl' spans.",
                "Make sure to recognise 'label' spans at the very beginning of the sequence.",
                "Preserve all original whitespace and punctuation within spans.",
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
                    parts.append(etree.tostring(child, encoding="unicode", with_tail=True))
                return ["".join(parts)]
        except etree.XMLSyntaxError as exc:
            logger.warning("tei-annotator footnote: could not parse result: %s", exc)

        return [original_element]
