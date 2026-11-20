"""
Registry for OCR engines.

Engine plugins register an OcrEngine instance here during their `initialize()`
lifecycle hook and unregister it in `cleanup()`. Consumers query it lazily
inside route handlers, mirroring LLMProviderRegistry and ExtractorRegistry.
"""

import logging

from .base import OcrEngine

logger = logging.getLogger(__name__)


class OcrEngineRegistry:
    """Singleton registry of OCR engines."""

    _instance: "OcrEngineRegistry | None" = None

    def __init__(self) -> None:
        self._engines: dict[str, OcrEngine] = {}

    @classmethod
    def get_instance(cls) -> "OcrEngineRegistry":
        """Get the singleton registry instance."""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Reset the singleton instance. Used for testing."""
        cls._instance = None

    def register(self, engine: OcrEngine) -> None:
        """Register an engine instance. Called by plugins during initialize()."""
        if not engine.id:
            raise ValueError("OCR engine has no id")
        self._engines[engine.id] = engine
        logger.debug(f"Registered OCR engine: {engine.id}")

    def unregister(self, engine_id: str) -> None:
        """Unregister an engine. Called by plugins during cleanup(). No-op if absent."""
        self._engines.pop(engine_id, None)

    def list_engines(self, available_only: bool = True) -> list[OcrEngine]:
        """List registered engines, optionally filtered to available ones."""
        return [e for e in self._engines.values() if not available_only or e.is_available()]

    def get_engine(self, engine_id: str) -> OcrEngine:
        """
        Get a registered engine.

        Raises:
            KeyError: If no engine with that id is registered.
        """
        return self._engines[engine_id]
