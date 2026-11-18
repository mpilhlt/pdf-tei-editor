"""
OCR engine registry and text layer analysis.

See base.py for the engine interface, registry.py for registration and
languages.py for the normalized language codes.
"""

from .base import OcrEngine, OcrOption, OcrOptionValue
from .registry import OcrEngineRegistry

__all__ = ["OcrEngine", "OcrOption", "OcrOptionValue", "OcrEngineRegistry"]
