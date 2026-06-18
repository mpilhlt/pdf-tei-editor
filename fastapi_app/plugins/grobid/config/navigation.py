"""Navigation XPath expressions for each GROBID variant."""

from typing import TypedDict


class XPathEntry(TypedDict):
    """A single navigable XPath target shown in the navigation toolbar."""

    value: str   # XPath expression using the tei: namespace prefix
    label: str   # HTML-escaped display label


NavigationXPath = dict[str, list[XPathEntry]]


NAVIGATION_XPATH: NavigationXPath = {
    "grobid.training.segmentation": [
        {"value": "//tei:listBibl", "label": "&lt;listBibl&gt;"},
    ],
    "grobid.training.references.referenceSegmenter": [
        {"value": "//tei:listBibl/tei:bibl", "label": "&lt;bibl&gt;"},
    ],
    "grobid.training.references": [
        {"value": "//tei:bibl", "label": "&lt;bibl&gt;"},
    ],
    "grobid.service.fulltext": [
        {"value": "//tei:div",  "label": "&lt;div&gt;"},
        {"value": "//tei:bibl", "label": "&lt;bibl&gt;"},
    ],
    "grobid.service.references": [
        {"value": "//tei:bibl", "label": "&lt;bibl&gt;"},
    ],
    "grobid.training.header.affiliation": [
        {"value": "//tei:affiliation", "label": "&lt;affiliation&gt;"},
    ],
    "grobid.training.header.authors": [
        {"value": "//tei:author", "label": "&lt;author&gt;"},
    ],
    "grobid.training.header.date": [
        {"value": "//tei:date", "label": "&lt;date&gt;"},
    ],
}
