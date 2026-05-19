"""
Footnote Annotator: splits a <bibl> containing multiple references into separate <bibl> elements.
"""

from __future__ import annotations

import logging

from lxml import etree

from fastapi_app.plugins.tei_annotator.annotators.base import BaseAnnotator
from fastapi_app.plugins.tei_annotator.annotators.schema import TEIElement, TEISchema
from fastapi_app.plugins.tei_annotator.config import TEI_NS
from fastapi_app.plugins.tei_annotator.utils import restore_lb

logger = logging.getLogger(__name__)


def _build_schema() -> TEISchema:
    return TEISchema(
        rules=[
            "Mark each distinct bibliographic reference as a 'bibl' span.  A new reference "
            "typically begins with an author's last name (often in ALL-CAPS or inverted "
            "'SURNAME, First' form) or with an introductory phrase such as 'Cf.', 'See', "
            "'Ver também:', 'Nesse sentido:', 'Ibidem', 'op. cit.'.",
            "CRITICAL: A footnote or endnote that cites multiple separate works — typically "
            "separated by a semicolon followed by a new author name, or by a period followed "
            "by a new author name in inverted/capitalised form — produces MULTIPLE 'bibl' "
            "spans, one per cited work.  Only the FIRST 'bibl' in the footnote carries the "
            "'label'; the remaining 'bibl' spans for the same footnote have no label.  "
            "Step-by-step example — '1. Robins (2013); Boss (2000); Kovras (2017).' → "
            "bibl span 1: text = '1. Robins (2013);', with a nested 'label' span text = '1'; "
            "bibl span 2: text = 'Boss (2000);' (no label); "
            "bibl span 3: text = 'Kovras (2017).' (no label).  "
            "ALL THREE cited works need their own 'bibl' span.  After wrapping the first bibl, "
            "continue wrapping every remaining citation into its own bibl.  "
            "Do NOT stop after 1 or 2 — wrap every cited work until the end of the footnote.  "
            "EXCEPTION: a semicolon that appears *within* an author list (e.g. 'COIMBRA, "
            "Marcelo; Manzi, Vanessa') is NOT a reference separator — it separates "
            "co-authors of the same work.",
            "CRITICAL: When a footnote entry begins with a label, ALL text in that entry — "
            "from the label to the end of the last citation — must be divided into one or more "
            "'bibl' spans.  No text between the opening label and the end of the footnote entry "
            "may be left as bare unwrapped text.  If the text immediately following the label "
            "is commentary rather than a formal citation, wrap it in a 'bibl' span anyway.",
            "If a reference begins with a numeric or alphanumeric label (footnote number, "
            "endnote number, or reference key), emit a 'label' span covering that label — "
            "including any brackets, parentheses, or trailing period that are part of the "
            "label format — as the very first span inside the enclosing 'bibl' span.  "
            "The whitespace or dash that separates the label from the first author is NOT "
            "part of the label span.",
            "Labels take many forms: plain integers ('1', '42'), integers with a trailing "
            "period ('1.', '42.'), integers in square brackets ('[1]', '[42]'), integers in "
            "parentheses ('(1)', '(42)'), letter-number codes ('5a'), or special characters "
            "such as '*'.  ALL of these forms are valid labels and must be tagged.  "
            "CRITICAL: The label span text MUST include ALL formatting characters — the "
            "trailing period, enclosing brackets, and enclosing parentheses belong INSIDE "
            "the span text.  Examples: '17.' → span text '17.' (NOT '17'); "
            "'[1]' → span text '[1]' (NOT '1'); '(1)' → span text '(1)' (NOT '1').",
            "A single cited work that spans multiple OCR line breaks is still ONE 'bibl' "
            "span.  Do NOT split a single citation at a line break.",
            "Include the trailing separator of each reference (the semicolon or period that "
            "terminates it) INSIDE that reference's 'bibl' span, not at the start of the "
            "next one.",
            "Introductory commentary that immediately precedes a reference and directs the "
            "reader to it — e.g. 'See', 'Cf.', 'Nesse sentido:', 'For a contrary view, "
            "see', 'siehe auch', 'ver também' — belongs INSIDE that reference's 'bibl' "
            "span.  When such commentary introduces two or more consecutive references, "
            "attach it to the immediately following reference.  "
            "When 'see also', 'cf.', or similar phrases appear in the MIDDLE of a "
            "multi-citation footnote (after one or more bibls containing a COMPLETE formal "
            "citation — i.e. author + title + publication — have already been emitted), "
            "they introduce a new 'bibl' span.  "
            "EXCEPTION: if the immediately preceding text is pure commentary that contains "
            "NO complete formal citation (e.g. a sentence mentioning an author in passing "
            "without a title or publisher), do NOT start a new bibl at 'see' or 'see also' — "
            "include that phrase and what follows in the same bibl as the commentary.",
            "Standalone commentary that does not directly refer to any specific reference, "
            "or that bridges two different references, should be included in the span that "
            "covers the FOLLOWING reference.",
            "Commentary that immediately follows a reference and elaborates on it — e.g. "
            "parenthetical remarks such as '(arguing that …)', brief paraphrases — belongs "
            "INSIDE that reference's 'bibl' span.",
            "Short self-contained cross-references such as 'Id.', 'Ibid.', 'Idem.', "
            "'Op. cit.', 'supra note N' each form their own individual 'bibl' span "
            "(with a 'label' if a label precedes them).",
            "Cover as much of the text as possible with 'bibl' spans.  Do not leave "
            "whitespace or punctuation gaps between spans.",
            "Do NOT nest 'bibl' spans inside other 'bibl' spans.",
            "Text that is NOT a bibliographic reference — section headings such as "
            "'References', 'Bibliography', 'Notes', or editorial annotations — must NOT "
            "be wrapped in a 'bibl' span.  Only actual reference entries get a 'bibl' span.",
            "Some reference lists use a purely alphabetical (author-date) format with no "
            "numeric labels.  In that case, every reference still gets a 'bibl' span, but "
            "no 'label' spans are emitted.",
            "Do NOT emit a 'label' span when the leading text is an author's surname "
            "(ALL-CAPS or mixed-case) rather than a numeric or alphanumeric code.",
        ],
        elements=[
            TEIElement(
                tag="bibl",
                description=(
                    "A span covering one complete bibliographic reference, including any "
                    "commentary that directly qualifies or elaborates on that specific "
                    "reference.  Commentary that immediately precedes a reference (e.g. "
                    "'See also', 'For a different view see', 'Cf.', and similar expressions "
                    "in other languages such as 'siehe auch', 'ver também') and belongs to "
                    "it must be included in the span.  Commentary that immediately follows a "
                    "reference and is clearly about that reference (e.g. '(arguing that …)', "
                    "'who first demonstrated that …') must also be included.  A 'bibl' span "
                    "must contain at minimum one verifiable bibliographic item — an author "
                    "name, title, publication, or a short-form citation ('Ibid.', 'op. cit.', "
                    "a bare page number following a prior citation).  An in-text mention of an "
                    "author by name (e.g. 'resembles Louis Althusser's distinction') qualifies "
                    "as a bibliographic item even without a publication title or date — wrap "
                    "such commentary in a 'bibl' span, especially when it follows a label or "
                    "precedes a formal citation.  Sources without named authors, such as "
                    "websites (title + URL), are also valid bibliographic references.  Standalone commentary that refers to no specific reference "
                    "or bridges two references should be included in the FOLLOWING reference's "
                    "span.  If the reference begins with a numeric or alphanumeric label, the "
                    "very first nested span inside this 'bibl' span MUST be a 'label' span — "
                    "never emit the label text as bare untagged text."
                ),
                allowed_children=["label"],
                attributes=[],
            ),
            TEIElement(
                tag="label",
                description=(
                    "A numeric or alphanumeric label at the very start of a reference that "
                    "identifies or numbers it.  Typical forms: a plain integer ('17'), an "
                    "integer with a trailing period ('17.'), an integer in square brackets "
                    "('[77]', '[ACL30]'), an integer in parentheses ('(3)'), a letter-number "
                    "code ('5a'), or a special character ('*').  The separator that follows "
                    "the label (period, dash, space, closing bracket) is NOT part of the "
                    "label.  A label is always a number or short code at the very beginning "
                    "of a reference — never a word, name, or sentence fragment.  "
                    "CRITICAL: A 'label' span MUST ALWAYS appear as the first nested span "
                    "inside a 'bibl' span.  Emitting a label as bare text outside a 'bibl' "
                    "span is always wrong.  If you are unsure how to divide the content "
                    "following the label, wrap the label AND all remaining text of that "
                    "footnote entry in a single 'bibl' span."
                ),
                allowed_children=[],
                attributes=[],
            ),
        ],
    )


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
        return _build_schema().to_dict()

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
