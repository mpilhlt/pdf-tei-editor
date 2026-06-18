"""Form option definitions for the extraction dialog."""

from typing import NotRequired, TypedDict

from fastapi_app.plugins.grobid.config.variants import PROCESSING_FLAVORS, SUPPORTED_VARIANTS


class FormOptionSpec(TypedDict):
    """Definition of a single form field shown in the extraction dialog."""

    type: str
    label: str
    description: str
    required: bool
    options: NotRequired[list[str]]


FormOptions = dict[str, FormOptionSpec]


FORM_OPTIONS: FormOptions = {
    "doi": {
        "type": "string",
        "label": "DOI",
        "description": "DOI of the document for metadata enrichment",
        "required": False,
    },
    "variant_id": {
        "type": "string",
        "label": "Variant identifier",
        "description": "Variant identifier for the training data type",
        "required": False,
        "options": SUPPORTED_VARIANTS,
    },
    "flavor": {
        "type": "string",
        "label": "GROBID processing flavor",
        "description": "Processing flavor that determines how GROBID analyzes the document structure",
        "required": False,
        "options": PROCESSING_FLAVORS,
    },
}
