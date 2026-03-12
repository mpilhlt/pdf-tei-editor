"""
Constants, schema builders, and text-processing helpers for the tei-annotator plugin.

Both annotation schemas are defined here so they are independent of the upstream
TEI Annotator webservice and can be updated without touching the server code.
"""

from __future__ import annotations

from lxml import etree

# ---------------------------------------------------------------------------
# Variant identifiers
# ---------------------------------------------------------------------------

VARIANT_REFERENCES = "grobid.training.references"
VARIANT_SEGMENTER  = "grobid.training.references.referenceSegmenter"

# ---------------------------------------------------------------------------
# Annotator service defaults
# ---------------------------------------------------------------------------

DEFAULT_PROVIDER   = "gemini"
DEFAULT_MODEL      = "gemini-2.5-flash"
DEFAULT_BATCH_SIZE = 5

# Placeholder used to round-trip <lb/> elements through plain text
LB_PLACEHOLDER = "|||LB|||"

# ---------------------------------------------------------------------------
# Schema URLs (for xml-model processing instruction in saved TEI)
# ---------------------------------------------------------------------------

SCHEMA_URL_REFERENCES = (
    "https://mpilhlt.github.io/grobid-footnote-flavour/schema/grobid.training.references.rng"
)
SCHEMA_URL_SEGMENTER = (
    "https://mpilhlt.github.io/grobid-footnote-flavour/schema/grobid.training.references.referenceSegmenter.rng"
)

# ---------------------------------------------------------------------------
# XML namespace
# ---------------------------------------------------------------------------

TEI_NS    = "http://www.tei-c.org/ns/1.0"
TEI_NSMAP = {"tei": TEI_NS}
TEI_LB    = f"{{{TEI_NS}}}lb"
TEI_BIBL  = f"{{{TEI_NS}}}bibl"


# ---------------------------------------------------------------------------
# Schema builders
# ---------------------------------------------------------------------------

def build_references_schema() -> dict:
    """
    Return the annotation schema for grobid.training.references.

    Full copy of the BLBL schema from tei_annotator/schemas/blbl.py,
    stored here so the plugin is independent of the upstream webservice.
    Sent as the 'schema' field of POST /api/annotate requests.
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
            "For each person's name, emit an 'author' or 'editor' span covering the full name "
            "AND separate 'surname', 'forename', or 'orgName' spans for the individual name "
            "parts within that span.",
            "Never emit 'surname', 'forename', or 'orgName' without a corresponding enclosing "
            "'author' or 'editor' span.",
            "When an organisation acts as author or editor, emit BOTH an 'orgName' span AND an "
            "enclosing 'author' (or 'editor') span. The 'author'/'editor' span MUST enclose the "
            "'orgName' span — NEVER put an 'author' or 'editor' span inside an 'orgName' span.",
            "CRITICAL: All name parts for all contiguous authors MUST always be placed inside a "
            "SINGLE 'author' (or 'editor') span — conjunctions ('and', '&', 'et') and commas "
            "between names do NOT create separate spans. Emit a new 'author' span only when "
            "the authors are separated by a title, date, or other non-name bibliographic field.",
            "In a bibliography, a dash or underscore may stand for a repeated author or editor "
            "name — tag it as 'author' or 'editor' accordingly.",
            "CRITICAL: When a parenthesised location appears immediately after a title "
            "(e.g. 'Title (City, Region)'), end the 'title' span BEFORE the opening parenthesis "
            "and emit a separate 'pubPlace' span covering only 'City, Region' (not the parentheses). "
            "Never include a parenthesised location inside a 'title' span.",
        ],
    }


def build_segmenter_schema() -> dict:
    """
    Return the annotation schema for grobid.training.references.referenceSegmenter.

    The LLM receives plain text (a footnote or list of references) and must identify
    spans corresponding to individual bibliographic references, optionally including
    immediately attached commentary. Labels (footnote numbers, reference numbers) are
    identified as nested spans within the reference span.
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
            "Mark each distinct bibliographic reference as a 'bibl' span.",
            "A 'bibl' span must contain at minimum one verifiable bibliographic item — "
            "author name, title, publication, or a short-form citation ('Ibid.', 'op. cit.', "
            "a bare page number following a prior citation). A phrase that contains no "
            "bibliographic content must NOT be marked as 'bibl'.",
            "CRITICAL — commentary inclusion: Take extra care when deciding whether adjacent "
            "commentary belongs to a reference. Commentary directly before a reference belongs "
            "to it if it introduces, qualifies, or directs the reader specifically to that "
            "reference (e.g. 'See', 'Cf.', 'For a contrary view, see'). Commentary directly "
            "after a reference belongs to it if it elaborates on or evaluates that specific "
            "source (e.g. parenthetical remarks, brief paraphrases). When commentary appears "
            "between two references, carefully determine which reference it modifies — include "
            "it in the span of the reference it belongs to, or leave it unspanned if it is "
            "genuinely standalone.",
            "Completely standalone commentary — general remarks unattached to any single "
            "reference, topic sentences, section headings — must NOT be included in any "
            "'bibl' span.",
            "When a reference begins with a number or short code that labels it, mark that "
            "label as a 'label' span nested inside the 'bibl' span.",
            "Do not nest 'bibl' spans inside other 'bibl' spans.",
            "Preserve all original whitespace and punctuation within spans.",
        ],
    }


# ---------------------------------------------------------------------------
# Text-processing helpers
# ---------------------------------------------------------------------------

def bibl_to_plain_text(bibl_el: etree._Element) -> str:
    """
    Extract plain text from a <bibl> element, replacing <lb/> with LB_PLACEHOLDER.

    All annotation child elements (author, title, etc.) are stripped; only their
    text content is preserved. lb milestone elements become the placeholder so
    they can be restored after annotation.
    """
    return _collect_text(bibl_el, strip_bibl=False)


def element_to_plain_text_with_lb(el: etree._Element) -> str:
    """
    Extract plain text from any element, replacing <lb/> with LB_PLACEHOLDER
    and stripping <bibl> wrapper tags along with all other annotation elements.

    Used for the referenceSegmenter variant where existing <bibl> segments
    must be removed before re-segmentation.
    """
    return _collect_text(el, strip_bibl=True)


def restore_lb(xml_fragment: str) -> str:
    """Replace LB_PLACEHOLDER occurrences with <lb/> in an XML fragment string."""
    return xml_fragment.replace(LB_PLACEHOLDER, "<lb/>")


def _collect_text(el: etree._Element, strip_bibl: bool) -> str:
    """
    Recursively collect text content of *el*, converting lb elements to the
    placeholder and stripping all other element wrappers.
    """
    parts: list[str] = []

    def _visit(node: etree._Element) -> None:
        # Include the element's own leading text
        if node.text:
            parts.append(node.text)
        for child in node:
            local = etree.QName(child.tag).localname if isinstance(child.tag, str) else None
            if local == "lb":
                parts.append(LB_PLACEHOLDER)
            elif local == "bibl" and strip_bibl:
                # Strip the bibl wrapper but recurse into its content
                _visit(child)
            else:
                # Strip annotation wrapper, recurse into content
                _visit(child)
            # Always include tail text (text after closing tag, before next sibling)
            if child.tail:
                parts.append(child.tail)

    # Start with the element's own text, then process children
    if el.text:
        parts.append(el.text)
    for child in el:
        local = etree.QName(child.tag).localname if isinstance(child.tag, str) else None
        if local == "lb":
            parts.append(LB_PLACEHOLDER)
        else:
            _visit(child)
        if child.tail:
            parts.append(child.tail)

    return "".join(parts)
