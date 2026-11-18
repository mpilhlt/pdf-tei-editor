"""
OCRmyPDF plugin.

Registers the OCRmyPDF/Tesseract OCR engine with the OcrEngineRegistry.
"""

import logging
import shutil
from typing import Any, Callable

from fastapi_app.lib.ocr.registry import OcrEngineRegistry
from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext

from .engine import OcrmypdfEngine

logger = logging.getLogger(__name__)


class OcrmypdfPlugin(Plugin):
    """Plugin that provides OCR via OCRmyPDF and Tesseract."""

    @property
    def metadata(self) -> dict[str, Any]:
        return {
            "id": "ocrmypdf",
            "name": "OCRmyPDF",
            "description": "Text recognition (OCR) for PDFs with OCRmyPDF and Tesseract",
            "category": "ocr",
            "version": "1.0.0",
            "required_roles": ["user"],
            "endpoints": [],
        }

    def get_endpoints(self) -> dict[str, Callable]:
        return {}

    @classmethod
    def is_available(cls) -> bool:
        return shutil.which("tesseract") is not None

    @classmethod
    def unavailable_reason(cls) -> str | None:
        return "The 'tesseract' program is not installed."

    async def initialize(self, context: PluginContext) -> None:
        OcrEngineRegistry.get_instance().register(OcrmypdfEngine())
        logger.info("Registered OCRmyPDF OCR engine")

    async def cleanup(self) -> None:
        OcrEngineRegistry.get_instance().unregister(OcrmypdfEngine.id)
