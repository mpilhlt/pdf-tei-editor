# TEI Annotator Plugin

## Purpose

The TEI Annotator plugin provides LLM-based annotation of elements in TEI documents. It connects to an external [TEI Annotator](https://github.com/mpilhlt/tei-annotator) webservice that uses large language models to identify and tag elements. For example, for the content of a given `<bibl>` element which contains no fine-grained annotation of bibliographic sub-elements, it can find and tag bibliographic fields (author, title, date, publisher, etc.).

The plugin currently supports two annotation workflows:

- **Reference annotation**: Tags the content of a single `<bibl>` element with structured bibliographic fields (author, title, date, publisher, place of publication, page ranges, identifiers, etc.).
- **Footnote segmentation**: Splits a `<bibl>` element that contains multiple concatenated references into separate `<bibl>` elements, each containing a single bibliographic item.

## Environment Variables

| Variable | Config Key | Required | Description |
|----------|-----------|----------|-------------|
| `TEI_ANNOTATOR_SERVER_URL` | `tei-annotator.server.url` | Yes | URL of the TEI Annotator webservice (e.g. `http://localhost:8099`) |
| `TEI_ANNOTATOR_API_KEY` | `tei-annotator.server.api-key` | No | API key for authenticated webservice access (sent as `Bearer` token) |
| `TEI_ANNOTATOR_PROVIDER` | `tei-annotator.provider` | No | LLM provider id (default: `gemini`) |
| `TEI_ANNOTATOR_MODEL` | `tei-annotator.model` | No | LLM model id (default: `gemini-2.5-flash`) |

The plugin is only available when `TEI_ANNOTATOR_SERVER_URL` is set. If this variable is absent, the plugin registers itself but the annotation functionality is disabled.

## Architecture

The plugin follows the project's backend plugin architecture and consists of several layers:

```text
fastapi_app/plugins/tei_annotator/
├── __init__.py          # Plugin entry point, exports plugin and router
├── plugin.py            # Plugin class (config init, frontend extension registration)
├── routes.py            # REST API endpoints
├── config.py            # Constants, XML namespace helpers, schema builders
├── utils.py             # Text-processing helpers and webservice call utility
├── extractor.py         # Legacy extractor (disabled, kept for reference)
├── annotators/          # Annotator classes (strategy pattern)
│   ├── __init__.py      # Annotator registry
│   ├── base.py          # Abstract base class
│   ├── reference.py     # ReferenceAnnotator
│   └── footnote.py      # FootnoteAnnotator
├── extensions/          # Frontend extension (JavaScript)
├── tests/               # Unit tests
└── README.md            # This file
```

### Key Components

**Plugin class** (`plugin.py`): Initializes configuration keys via `get_plugin_config()` in its `__init__` method and registers the frontend extension that adds a "TEI Annotator" submenu to the Tools menu.

**Annotators** (`annotators/`): A strategy pattern where each annotator class encapsulates the schema, text extraction, and result processing for one annotation task. Annotators are registered in `annotators/__init__.py` and looked up by id.

**Routes** (`routes.py`): Two REST endpoints that authenticate the user, load the document, find the target element by XPath, call the webservice, and return the annotated XML fragments.

**Utils** (`utils.py`): Text-processing helpers (`bibl_to_plain_text`, `element_to_plain_text_with_lb`, `restore_lb`) that handle `<lb/>` placeholder round-tripping, and the `call_annotate` function that performs the HTTP call to the webservice.

### Annotator Interface

All annotators inherit from `BaseAnnotator` (in `annotators/base.py`) and must implement:

| Member | Type | Description |
|--------|------|-------------|
| `id` | `str` | Unique identifier used in API requests |
| `display_name` | `str` | Human-readable label for the UI |
| `description` | `str` | Tooltip description |
| `target_tag` | `str` | XML element local name this annotator targets (default: `"bibl"`) |
| `get_schema()` | method | Returns the annotation schema dict sent to the webservice |
| `apply_result(original_element, annotated_xml)` | method | Parses the webservice response and returns replacement elements |

The base class provides default implementations for `provider` and `model` properties (read from config) and `get_plain_text()` (extracts text using `bibl_to_plain_text`).

## REST API

All endpoints require authentication via session ID (query parameter `session_id` or header `X-Session-ID`).

### `GET /api/plugins/tei-annotator/annotators`

Lists all registered annotators.

**Response** (JSON array):

```json
[
  {
    "id": "reference",
    "display_name": "Reference Annotator",
    "description": "Tags the content of a <bibl> element with bibliographic fields...",
    "target_tag": "bibl"
  },
  {
    "id": "footnote",
    "display_name": "Footnote Annotator",
    "description": "Splits a <bibl> element containing multiple references...",
    "target_tag": "bibl"
  }
]
```

### `POST /api/plugins/tei-annotator/annotate`

Annotates a single XML element selected by XPath in the given document.

**Request body** (JSON):

```json
{
  "stable_id": "abc123",
  "xpath": "//tei:listBibl/tei:bibl[1]",
  "annotator_id": "reference"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `stable_id` | `string` | Document stable identifier |
| `xpath` | `string` | XPath expression selecting the target element |
| `annotator_id` | `string` | Annotator id (e.g. `"reference"` or `"footnote"`) |

**Response** (JSON):

```json
{
  "fragments": [
    "<bibl><author><surname>Doe</surname><forename>J.</forename></author> (2024). <title>A paper</title>.</bibl>"
  ]
}
```

The `fragments` array contains one or more XML fragment strings. For the reference annotator, this is typically a single `<bibl>` element. For the footnote annotator, this may be multiple `<bibl>` elements resulting from segmentation.

## Adding a New Annotator

To add a new annotation task, create a new annotator class following these steps:

### 1. Create the annotator module

Create a new file in `annotators/` (e.g. `annotators/my_annotator.py`):

```python
"""
My Annotator: description of what this annotator does.
"""

from __future__ import annotations

import logging

from lxml import etree

from fastapi_app.plugins.tei_annotator.annotators.base import BaseAnnotator
from fastapi_app.plugins.tei_annotator.config import TEI_NS
from fastapi_app.plugins.tei_annotator.utils import restore_lb

logger = logging.getLogger(__name__)


class MyAnnotator(BaseAnnotator):
    """Brief description of the annotator's behavior."""

    id = "my-annotator"
    display_name = "My Annotator"
    description = "Short tooltip description."
    target_tag = "bibl"  # Change if targeting a different element

    def get_schema(self) -> dict:
        """
        Return the annotation schema sent to the webservice.

        The schema defines:
        - elements: list of tag definitions with descriptions, allowed_children, and attributes
        - rules: list of instruction strings for the LLM
        """
        return {
            "elements": [
                {
                    "tag": "author",
                    "description": "Name of the author.",
                    "allowed_children": ["surname", "forename"],
                    "attributes": [],
                },
                # ... more elements
            ],
            "rules": [
                "Rule 1: ...",
                "Rule 2: ...",
            ],
        }

    def apply_result(
        self,
        original_element: etree._Element,
        annotated_xml: str,
    ) -> list[etree._Element]:
        """
        Parse the webservice response and return replacement elements.

        On failure (empty or unparseable XML), return [original_element].
        """
        if not annotated_xml:
            return [original_element]

        restored = restore_lb(annotated_xml)
        try:
            parser = etree.XMLParser(recover=True)
            new_element = etree.fromstring(
                f'<bibl xmlns="{TEI_NS}">{restored}</bibl>'.encode("utf-8"),
                parser,
            )
            return [new_element]
        except etree.XMLSyntaxError as exc:
            logger.warning("my-annotator: could not parse result: %s", exc)
            return [original_element]
```

### 2. Register the annotator

Add the new class to `annotators/__init__.py`:

```python
from fastapi_app.plugins.tei_annotator.annotators.my_annotator import MyAnnotator

ANNOTATORS: list[BaseAnnotator] = [FootnoteAnnotator(), ReferenceAnnotator(), MyAnnotator()]
```

### 3. Add tests

Create a test file in `tests/` and add test cases covering:

- Schema structure (expected elements, rules)
- Annotator metadata (id, target_tag, display_name)
- `apply_result()` behavior with valid XML, empty XML, and malformed XML
- Registry lookup by id

See `tests/test_plugin.py` for examples.

### 4. Update the frontend (optional)

If the annotator should be accessible from the UI menu, update the frontend extension in `extensions/` to include a menu item for the new annotator id.
