"""GROBID annotation tag definitions."""

from typing import TypedDict


class AttributeSpec(TypedDict):
    """A named attribute with an enumerated set of allowed values."""

    name: str
    values: list[str]


class AnnotationTag(TypedDict, total=False):
    """A single annotation tag entry in the annotation toolbar."""

    tag: str
    label: str
    color: str
    priority: int
    defaultAttributes: dict[str, str] | None
    description: str
    attributes: list[AttributeSpec]
    childTags: list[str]


AnnotationTagsMap = dict[str, list[AnnotationTag]]


ANNOTATION_TAGS: AnnotationTagsMap = {
    "grobid.training.segmentation": [
        {
            "tag": "body",
            "label": "body",
            "color": "#89dceb",
            "priority": 1,
            "defaultAttributes": None,
            "description": "The main body of the document",
        },
        {
            "tag": "listBibl",
            "label": "listBibl",
            "color": "#f38ba8",
            "priority": 2,
            "defaultAttributes": None,
            "description": "Bibliographical section",
        },
        {
            "tag": "front",
            "label": "front",
            "color": "#89b4fa",
            "priority": 3,
            "defaultAttributes": None,
            "description": "Document header / front matter",
        },
        {
            "tag": "titlePage",
            "label": "titlePage",
            "color": "#cba6f7",
            "priority": 4,
            "defaultAttributes": None,
            "description": "Cover page",
        },
        {
            "tag": "note",
            "label": "note[foot]",
            "color": "#94e2d5",
            "priority": 5,
            "defaultAttributes": {"place": "footnote"},
            "description": "Page footer or numbered footnote",
        },
        {
            "tag": "page",
            "label": "page",
            "color": "#f9e2af",
            "priority": 6,
            "defaultAttributes": None,
            "description": "Page number indicator",
        },
        {
            "tag": "div",
            "label": "acknowledgement",
            "color": "#a6e3a1",
            "priority": 7,
            "defaultAttributes": {"type": "acknowledgement"},
            "description": "Acknowledgement statement in the annex",
        },
        {
            "tag": "div",
            "label": "toc",
            "color": "#f5c2e7",
            "priority": 8,
            "defaultAttributes": {"type": "toc"},
            "description": "Table of contents",
        },
        {
            "tag": "note",
            "label": "note[head]",
            "color": "#74c7ec",
            "priority": 9,
            "defaultAttributes": {"place": "headnote"},
            "description": "Page header / running head",
        },
        {
            "tag": "div",
            "label": "annex",
            "color": "#585b70",
            "priority": 10,
            "defaultAttributes": {"type": "annex"},
            "description": "Any other annex section",
        },
        {
            "tag": "div",
            "label": "funding",
            "color": "#f2cdcd",
            "priority": 11,
            "defaultAttributes": {"type": "funding"},
            "description": "Funding information annex",
        },
        {
            "tag": "div",
            "label": "conflict",
            "color": "#eba0ac",
            "priority": 12,
            "defaultAttributes": {"type": "conflict"},
            "description": "Conflict of interest statement",
        },
        {
            "tag": "div",
            "label": "contribution",
            "color": "#b4befe",
            "priority": 13,
            "defaultAttributes": {"type": "contribution"},
            "description": "Author contribution statement",
        },
        {
            "tag": "div",
            "label": "availability",
            "color": "#45475a",
            "priority": 14,
            "defaultAttributes": {"type": "availability"},
            "description": "Data/code availability statement",
        },
    ],
    "grobid.training.references.referenceSegmenter": [
        {
            "tag": "bibl",
            "label": "bibl",
            "color": "#89dceb",
            "priority": 1,
            "defaultAttributes": None,
            "description": "An individual bibliographic reference",
            "childTags": ["label"],
        },
        {
            "tag": "bibl",
            "label": "bibl[footnote]",
            "color": "#94e2d5",
            "priority": 2,
            "defaultAttributes": {"type": "footnote"},
            "description": "A note or comment that is not a bibliographic reference",
            "childTags": ["label"],
        },
        {
            "tag": "label",
            "label": "label",
            "color": "#a6e3a1",
            "priority": 3,
            "defaultAttributes": None,
            "description": "Reference number or footnote marker (e.g. [1], ¹)",
        },
    ],
    "grobid.training.references": [
        {
            "tag": "author",
            "label": "author",
            "color": "#89b4fa",
            "priority": 1,
            "defaultAttributes": None,
            "description": "Complete sequence of author names",
        },
        {
            "tag": "title",
            "label": "title[a]",
            "color": "#a6e3a1",
            "priority": 2,
            "defaultAttributes": {"level": "a"},
            "description": "Article or chapter title (analytics)",
            "attributes": [{"name": "level", "values": ["a", "j", "m", "s"]}],
        },
        {
            "tag": "title",
            "label": "title[j]",
            "color": "#74c7ec",
            "priority": 3,
            "defaultAttributes": {"level": "j"},
            "description": "Journal title",
            "attributes": [{"name": "level", "values": ["a", "j", "m", "s"]}],
        },
        {
            "tag": "date",
            "label": "date",
            "color": "#fab387",
            "priority": 4,
            "defaultAttributes": None,
            "description": "Publication date sequence",
        },    
        {
            "tag": "biblScope",
            "label": "pages",
            "color": "#f9e2af",
            "priority": 5,
            "defaultAttributes": {"unit": "page"},
            "description": "Full page range of the article",
        },
        {
            "tag": "title",
            "label": "title[m]",
            "color": "#94e2d5",
            "priority": 6,
            "defaultAttributes": {"level": "m"},
            "description": "Monograph, proceedings, book, or thesis title",
            "attributes": [{"name": "level", "values": ["a", "j", "m", "s"]}],
        },
        {
            "tag": "publisher",
            "label": "publisher",
            "color": "#cba6f7",
            "priority": 7,
            "defaultAttributes": None,
            "description": "Publisher name; also used for corporate authors such as web pages",
        },
        {
            "tag": "biblScope",
            "label": "volume",
            "color": "#f5c2e7",
            "priority": 8,
            "defaultAttributes": {"unit": "volume"},
            "description": "Volume number",
        },
        {
            "tag": "biblScope",
            "label": "issue",
            "color": "#eba0ac",
            "priority": 9,
            "defaultAttributes": {"unit": "issue"},
            "description": "Issue / number",
        },
        {
            "tag": "edition",
            "label": "edition",
            "color": "#d18455",
            "priority": 10,
            "defaultAttributes": None,
            "description": "Edition of a publication",
        },            
        {
            "tag": "orgName",
            "label": "orgName",
            "color": "#f38ba8",
            "priority": 10,
            "defaultAttributes": None,
            "description": "Institution for theses or technical reports",
        },
        {
            "tag": "pubPlace",
            "label": "pubPlace",
            "color": "#89dceb",
            "priority": 11,
            "defaultAttributes": None,
            "description": "Publication place or location of publishing institution",
        },
        {
            "tag": "editor",
            "label": "editor",
            "color": "#b4befe",
            "priority": 12,
            "defaultAttributes": None,
            "description": "Sequence of editor names",
        },
        {
            "tag": "ptr",
            "label": "URL",
            "color": "#74c7ec",
            "priority": 13,
            "defaultAttributes": {"type": "web"},
            "description": "Web URL (exclude prefixes like 'URL:' and trailing periods)",
        },
        {
            "tag": "idno",
            "label": "idno",
            "color": "#45475a",
            "priority": 14,
            "defaultAttributes": None,
            "description": "Document identifier (DOI, arXiv, etc.)",
            "attributes": [{"name": "type", "values": ["DOI", "arXiv", "report"]}],
        },
        {
            "tag": "note",
            "label": "note",
            "color": "#9399b2",
            "priority": 15,
            "defaultAttributes": None,
            "description": "Any note not covered by another tag",
        },
        {
            "tag": "title",
            "label": "title[s]",
            "color": "#b4befe",
            "priority": 16,
            "defaultAttributes": {"level": "s"},
            "description": "Series title",
            "attributes": [{"name": "level", "values": ["a", "j", "m", "s"]}],
        },
        {
            "tag": "orgName",
            "label": "collaboration",
            "color": "#f2cdcd",
            "priority": 17,
            "defaultAttributes": {"type": "collaboration"},
            "description": "Project-based collaboration acting as an author group",
        },
        {
            "tag": "note",
            "label": "note[report]",
            "color": "#585b70",
            "priority": 18,
            "defaultAttributes": {"type": "report"},
            "description": "Type of report or thesis (e.g. 'Ph.D. thesis', 'Technical Report')",
        },
    ],
}
