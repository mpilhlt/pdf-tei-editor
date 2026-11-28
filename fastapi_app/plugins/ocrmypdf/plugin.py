"""
OCRmyPDF plugin.

Registers the OCRmyPDF/Tesseract OCR engine with the OcrEngineRegistry, links the
tessdata_best models from the shared data directory and downloads the configured ones
in the background (see tessdata.py).
"""

import logging
import shutil
import threading
from pathlib import Path
from typing import Any, Callable

from fastapi_app.config import get_settings
from fastapi_app.lib.core.shared_data import get_shared_data_dir
from fastapi_app.lib.ocr.registry import OcrEngineRegistry
from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.plugins.plugin_tools import get_plugin_config

from . import tessdata
from .engine import OcrmypdfEngine

BEST_LANGUAGES_CONFIG_KEY = "ocr.tesseract.best_languages"

logger = logging.getLogger(__name__)


class OcrmypdfPlugin(Plugin):
    """Plugin that provides OCR via OCRmyPDF and Tesseract."""

    def __init__(self) -> None:
        super().__init__()
        self._best_languages: list[str] = tessdata.parse_languages(get_plugin_config(
            BEST_LANGUAGES_CONFIG_KEY,
            "TESSERACT_BEST_LANGS",
            default="",
            description="Tesseract languages (e.g. 'eng deu') whose tessdata_best models are downloaded at startup into the shared data directory",
        ))

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
        engine = OcrmypdfEngine()
        OcrEngineRegistry.get_instance().register(engine)
        logger.info("Registered OCRmyPDF OCR engine")
        best_dir = self._setup_tessdata()
        if best_dir is not None and self._best_languages:
            thread = threading.Thread(
                target=tessdata.download_best_models,
                args=(self._best_languages, best_dir, engine.invalidate_models),
                name="tessdata-best-download",
                daemon=True,
            )
            thread.start()

    @staticmethod
    def _setup_tessdata() -> Path | None:
        """
        Link the shared best-model folder and point Tesseract at the link folder.

        Returns:
            The shared best-model folder, or None if the setup failed (the system models are used then)
        """
        try:
            link_dir = get_settings().plugins_data_dir / "ocrmypdf" / "tessdata"
            system_dir = tessdata.system_tessdata_dir(link_dir)
            if system_dir is None:
                return None
            best_dir = get_shared_data_dir(tessdata.BEST_MODELS_DIR_NAME)
            tessdata.build_link_dir(system_dir, best_dir, link_dir)
            tessdata.set_tessdata_prefix(link_dir)
            logger.debug(f"Tesseract models: {system_dir} and {best_dir}, linked in {link_dir}")
            return best_dir
        except Exception as e:
            logger.warning(f"Could not set up the tessdata_best models, using the system models only: {e}")
            return None

    async def cleanup(self) -> None:
        OcrEngineRegistry.get_instance().unregister(OcrmypdfEngine.id)
