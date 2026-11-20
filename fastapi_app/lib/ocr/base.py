"""
Base class for OCR engines.

An OCR engine reads a PDF and writes a copy whose text layer has been
(re-)created by text recognition. The page geometry must stay the same, so that
coordinates of existing annotations remain valid.

Engines can optionally recognize the words on a page image (see
OcrEngine.recognize_words), which the text layer check uses to find text layers
whose text does not match the page or sits in the wrong place.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Optional, Required, TypedDict

OcrOptionValue = str | bool | int

OcrMethod = Literal["skip", "redo", "force", "vectorize"]
"""
How the text layer was (re-)created:

- skip: only pages without text were recognized
- redo: an existing OCR layer was replaced
- force: all pages were rasterized and recognized
- vectorize: the existing text was converted to outlines (keeping vector graphics) and the pages were recognized
"""


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


@dataclass(frozen=True)
class OcrWord:
    """
    A word recognized on a page image.

    Coordinates are fractions of the image width and height (0-1), with the origin at the top
    left corner.
    """

    text: str
    left: float
    top: float
    right: float
    bottom: float
    confidence: float = 1.0
    """Recognition confidence (0-1)."""


@dataclass
class OcrResult:
    """Result of OcrEngine.recognize()."""

    message: Optional[str] = None
    """Message for the user, e.g. which method was used."""

    method: Optional[OcrMethod] = None
    """The method actually used, if the engine distinguishes methods."""

    fallback_reason: Optional[str] = None
    """Why the engine fell back from the preferred method, if it did."""


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

    def supports_word_recognition(self) -> bool:
        """Return whether recognize_words() is implemented."""
        return False

    def recognize_words(self, image_path: Path, languages: list[str]) -> list[OcrWord]:
        """
        Recognize the words on a page image, with their positions.

        Called in a worker thread, so it may block. Only called if supports_word_recognition()
        returns True.

        Args:
            image_path: A PNG image of a page
            languages: Normalized language codes, all supported by the engine

        Returns:
            The recognized words in reading order
        """
        raise NotImplementedError(f"{self.name} does not support word recognition")

    @abstractmethod
    def recognize(
        self,
        input_path: Path,
        output_path: Path,
        languages: list[str],
        options: dict[str, OcrOptionValue],
        rebuild: bool = False,
    ) -> Optional[str | OcrResult]:
        """
        Apply OCR to a PDF and write the result to a new file.

        Called in a worker thread, so it may block.

        Args:
            input_path: The PDF to process
            output_path: Where to write the processed PDF
            languages: Normalized language codes, all supported by the engine
            options: Parameter values, validated against get_options()
            rebuild: True if the user explicitly asked to recreate the text layer. Engines that
                choose a method automatically should then replace a digital text layer even if
                it looks fine, since the automatic check cannot find all problems.

        Returns:
            An optional message for the user (e.g. which pages were skipped), or an OcrResult
        """
