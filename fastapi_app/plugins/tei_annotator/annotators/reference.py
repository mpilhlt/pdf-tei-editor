"""
Reference Annotator: tags <bibl> content with bibliographic fields (author, title, date, etc.).
"""

from __future__ import annotations

import logging

from lxml import etree

from fastapi_app.plugins.tei_annotator.annotators.base import BaseAnnotator
from fastapi_app.plugins.tei_annotator.config import TEI_NS
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
        """
        Return the annotation schema for tagging bibliographic fields inside a <bibl>.
        """
        return {
            "elements": [
                {
                    "tag": "author",
                    "description": (
                        "Name(s) of the author(s) of the cited work. "
                        "Names appearing at the start of a bibliographic entry before the title and "
                        "date are authors."
                    ),
                    "allowed_children": ["surname", "forename", "orgName"],
                    "attributes": [],
                },
                {
                    "tag": "editor",
                    "description": (
                        "Name of an editor of the cited work. "
                        "An editor's name typically follows keywords such as 'in', 'ed.', 'éd.', "
                        "'Hrsg.', 'dir.', '(ed.)', '(eds.)'. "
                        "CRITICAL: A person's name (or surname alone) that follows 'in' is an editor — "
                        "emit an 'editor' span (plus name-part spans), never a 'title' span."
                    ),
                    "allowed_children": ["surname", "forename", "orgName"],
                    "attributes": [],
                },
                {
                    "tag": "surname",
                    "description": "The inherited (family) name of a person.",
                    "allowed_children": [],
                    "attributes": [],
                },
                {
                    "tag": "forename",
                    "description": "The given (first) name or initials of a person.",
                    "allowed_children": [],
                    "attributes": [],
                },
                {
                    "tag": "orgName",
                    "description": (
                        "Name of an organisation that acts as author or editor. "
                        "Do NOT emit an 'orgName' span inside a 'publisher' span — "
                        "when an organisation is the publisher, use 'publisher' alone."
                    ),
                    "allowed_children": [],
                    "attributes": [],
                },
                {
                    "tag": "title",
                    "description": (
                        "Title of the cited work. "
                        "Do NOT split a title at an internal period or subtitle separator — "
                        "e.g. 'Classical Literary Criticism. Oxford World Classics' is ONE title span; "
                        "a city name embedded in a subtitle (e.g. 'Oxford' in 'Oxford World Classics') "
                        "is NOT a pubPlace — do not interrupt the title span with a pubPlace span. "
                        "CRITICAL: The title span ends BEFORE any parenthesised location — "
                        "e.g. in 'Title (City, Region)', only 'Title' is the title span; "
                        "'City, Region' is a separate pubPlace span. "
                        "A journal or series title may appear after keywords such as 'in', 'dans', 'in:' — "
                        "emit a 'title' span for it; do NOT tag it as 'note'."
                    ),
                    "allowed_children": [],
                    "attributes": [
                        {
                            "name": "level",
                            "description": "Publication level: 'a'=article/chapter, 'm'=monograph/book, 'j'=journal, 's'=series.",
                            "allowed_values": ["a", "m", "j", "s"],
                        }
                    ],
                },
                {
                    "tag": "date",
                    "description": (
                        "Publication date or year. "
                        "When two dates appear in sequence — e.g. '1989 [1972]' (reprint year and "
                        "original year) — emit a SEPARATE 'date' span for each individual date."
                    ),
                    "allowed_children": [],
                    "attributes": [],
                },
                {
                    "tag": "publisher",
                    "description": (
                        "Name of the publisher. "
                        "When multiple publishers are connected by 'and', emit a SINGLE 'publisher' "
                        "span covering the full text. Do NOT nest 'orgName' inside 'publisher'."
                    ),
                    "allowed_children": [],
                    "attributes": [],
                },
                {
                    "tag": "pubPlace",
                    "description": (
                        "Place of publication. "
                        "CRITICAL: When a location appears in parentheses immediately after the title "
                        "(e.g. 'Title (City, Region)'), the parenthesised location is the pubPlace — "
                        "emit a 'pubPlace' span covering only 'City, Region' (without parentheses), "
                        "and end the 'title' span BEFORE the opening parenthesis. "
                        "Only tag a city name as pubPlace when it appears OUTSIDE and AFTER the title, "
                        "typically before a colon and publisher name (e.g. 'Oxford: Oxford UP'). "
                        "A city name that is part of a subtitle or series name within a title is NOT a pubPlace."
                    ),
                    "allowed_children": [],
                    "attributes": [],
                },
                {
                    "tag": "biblScope",
                    "description": (
                        "Scope reference within the cited item (page range, volume, issue). "
                        "Emit a separate 'biblScope' span for volume and for issue. "
                        "The span text contains ONLY the bare number — do not include labels "
                        "('Vol.', 'No.', 'n°', 't.') or surrounding punctuation/parentheses. "
                        "E.g. for 'Vol. 12(3)', emit '12' as unit='volume' and '3' as unit='issue'. "
                        "Do NOT absorb a volume or issue number into a preceding title span."
                    ),
                    "allowed_children": [],
                    "attributes": [
                        {
                            "name": "unit",
                            "description": "Unit of the scope reference.",
                            "allowed_values": ["page", "volume", "issue"],
                        }
                    ],
                },
                {
                    "tag": "idno",
                    "description": "Bibliographic identifier such as DOI, ISBN, or ISSN.",
                    "allowed_children": [],
                    "attributes": [{"name": "type", "description": "Identifier type, e.g. DOI, ISBN, ISSN."}],
                },
                {
                    "tag": "note",
                    "description": (
                        "A note attached to the cited item. Two distinct uses: "
                        "(1) type='report' — institutional or series report designations such as "
                        "'Amok Internal Report', 'USGS Open-File Report 97-123', or "
                        "'Technical Report No. 5'. Must be tagged as 'note' with type='report', "
                        "NOT as 'orgName' or 'title'. "
                        "(2) type='comment' — commentary text that was included inside a 'bibl' span "
                        "during the reference-segmentation phase because it directly qualifies or "
                        "elaborates on this specific reference. Mark such commentary with type='comment' "
                        "so it can be distinguished from proper bibliographic fields."
                    ),
                    "allowed_children": [],
                    "attributes": [
                        {
                            "name": "type",
                            "description": "Type of note.",
                            "allowed_values": ["report", "comment"],
                        }
                    ],
                },
                {
                    "tag": "ptr",
                    "description": "Pointer to an external resource such as a URL.",
                    "allowed_children": [],
                    "attributes": [{"name": "type", "description": "Type of pointer, e.g. 'web'."}],
                },
            ],
            "rules": [
                "- Take care to separate bibliographical information from surrounding commentary. "
                "Comments might preceed or follow the bibliographic data; in some cases, some part "
                "of the bibliographic data is contained in the commentary, to be followed by the missing "
                "information (e.g. 'Miller has argued, in a famous article (<ref without author>) that ...'), followed by"
                "more commentary.\n"
                "- For each person's name, emit an 'author' or 'editor' span covering the full name "
                "AND separate 'surname', 'forename', or 'orgName' spans for the individual name "
                "parts within that span.",
                "Never emit 'surname', 'forename', or 'orgName' without a corresponding enclosing "
                "'author' or 'editor' span.\n",
                "- When an organisation acts as author or editor, emit BOTH an 'orgName' span AND an "
                "enclosing 'author' (or 'editor') span. The 'author'/'editor' span MUST enclose the "
                "'orgName' span — NEVER put an 'author' or 'editor' span inside an 'orgName' span.",
                "CRITICAL: All name parts for all contiguous authors MUST always be placed inside a "
                "SINGLE 'author' (or 'editor') span — conjunctions ('and', '&', 'et') and commas "
                "between names do NOT create separate spans. Emit a new 'author' span only when "
                "the authors are separated by a title, date, or other non-name bibliographic field.\n",
                "- In a bibliography, a dash or underscore may stand for a repeated author or editor "
                "name — tag it as 'author' or 'editor' accordingly.",
                "CRITICAL: When a parenthesised location appears immediately after a title "
                "(e.g. 'Title (City, Region)'), end the 'title' span BEFORE the opening parenthesis "
                "and emit a separate 'pubPlace' span covering only 'City, Region' (not the parentheses). "
                "Never include a parenthesised location inside a 'title' span.",
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
            new_bibl = etree.fromstring(
                f'<bibl xmlns="{TEI_NS}">{restored}</bibl>'.encode("utf-8"),
                parser,
            )
            return [new_bibl]
        except etree.XMLSyntaxError as exc:
            logger.warning("tei-annotator reference: could not parse result: %s", exc)
            return [original_element]
