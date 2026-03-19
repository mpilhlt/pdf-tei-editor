"""
Base class for TEI Annotator annotators.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from lxml import etree

from fastapi_app.lib.utils.config_utils import get_config
from fastapi_app.plugins.tei_annotator.config import DEFAULT_MODEL, DEFAULT_PROVIDER
from fastapi_app.plugins.tei_annotator.utils import bibl_to_plain_text


class BaseAnnotator(ABC):
    """
    Encapsulates schema, configuration, and result-processing logic for one annotation task.

    Subclasses define the schema and how to transform the webservice response back into
    XML elements that replace the original element in the document tree.
    """

    #: Unique identifier used in API requests and config key suffixes.
    id: str

    #: Human-readable label shown in the Tools menu.
    display_name: str

    #: Short description shown as a tooltip in the menu.
    description: str

    #: Local name of the XML element this annotator targets (default: "bibl").
    target_tag: str = "bibl"

    @property
    def provider(self) -> str:
        """LLM provider id, from config key ``tei-annotator.provider``."""
        return get_config().get("tei-annotator.provider", default=DEFAULT_PROVIDER)

    @property
    def model(self) -> str:
        """LLM model id, from config key ``tei-annotator.model``."""
        return get_config().get("tei-annotator.model", default=DEFAULT_MODEL)

    @abstractmethod
    def get_schema(self) -> dict:
        """Return the annotation schema dict sent to the webservice."""

    def get_plain_text(self, element: etree._Element) -> str:
        """Extract plain text from *element*, replacing <lb/> with the placeholder."""
        return bibl_to_plain_text(element)

    @abstractmethod
    def apply_result(
        self,
        original_element: etree._Element,
        annotated_xml: str,
    ) -> list[etree._Element]:
        """
        Parse *annotated_xml* and return the list of elements that should replace
        *original_element* in its parent.

        On failure, return ``[original_element]`` to preserve the original.
        """
