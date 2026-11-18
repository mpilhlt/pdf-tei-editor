"""
Base class for OCR engines.

An OCR engine reads a PDF and writes a copy whose text layer has been
(re-)created by text recognition. The page geometry must stay the same, so that
coordinates of existing annotations remain valid.
"""

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Literal, Optional, Required, TypedDict

OcrOptionValue = str | bool | int


class OcrOption(TypedDict, total=False):
    """
    Description of an engine parameter, rendered as a form field by the OCR dialog.

    Keys:
        type: "string" (a select box if `options` is given, otherwise a text field),
            "boolean" (a checkbox) or "integer" (a number field)
        label: Field label
        description: Help text
        options: Allowed values for a "string" option
        default: Default value
    """

    type: Required[Literal["string", "boolean", "integer"]]
    label: str
    description: str
    options: list[str]
    default: OcrOptionValue


class OcrEngine(ABC):
    """Base class for OCR engines registered with the OcrEngineRegistry."""

    id: str = ""
    """Unique identifier of the engine."""

    name: str = ""
    """Human-readable name."""

    description: str = ""
    """Short description of the engine."""

    def get_options(self) -> dict[str, OcrOption]:
        """
        Return the parameters the engine accepts, apart from the languages.

        Returns:
            Parameter descriptions keyed by parameter name
        """
        return {}

    @abstractmethod
    def is_available(self) -> bool:
        """Return whether the engine can run in this environment."""

    @abstractmethod
    def get_languages(self) -> list[str]:
        """
        Return the languages the engine can recognize.

        Returns:
            Normalized language codes (see fastapi_app.lib.ocr.languages)
        """

    def get_default_languages(self) -> list[str]:
        """Return the languages used when the caller specifies none."""
        return ["en"] if "en" in self.get_languages() else self.get_languages()[:1]

    @abstractmethod
    def recognize(
        self,
        input_path: Path,
        output_path: Path,
        languages: list[str],
        options: dict[str, OcrOptionValue],
    ) -> Optional[str]:
        """
        Apply OCR to a PDF and write the result to a new file.

        Called in a worker thread, so it may block.

        Args:
            input_path: The PDF to process
            output_path: Where to write the processed PDF
            languages: Normalized language codes, all supported by the engine
            options: Parameter values, validated against get_options()

        Returns:
            An optional message for the user (e.g. which pages were skipped)
        """
