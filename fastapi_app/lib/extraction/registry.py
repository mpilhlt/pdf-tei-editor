"""
Extractor registry for managing extraction engines.

Plugins register their extractors via this registry during initialization.
"""

import logging
from typing import Dict, List, Any, Type

from .base import BaseExtractor

logger = logging.getLogger(__name__)


class ExtractorRegistry:
    """Registry for managing extraction engines."""

    _instance: "ExtractorRegistry | None" = None

    def __init__(self):
        self._extractors: Dict[str, Type[BaseExtractor]] = {}

    @classmethod
    def get_instance(cls) -> "ExtractorRegistry":
        """Get the singleton registry instance."""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Reset the singleton instance. Used for testing."""
        cls._instance = None

    def register(self, extractor_class: Type[BaseExtractor]) -> None:
        """
        Register an extractor class. Called by plugins during initialization.

        Args:
            extractor_class: The extractor class to register
        """
        info = extractor_class.get_info()
        extractor_id = info.get('id')
        if extractor_id:
            self._extractors[extractor_id] = extractor_class
            logger.debug(f"Registered extractor: {extractor_id}")

    def unregister(self, extractor_id: str) -> None:
        """
        Unregister an extractor. Called by plugins during cleanup.

        Args:
            extractor_id: The ID of the extractor to unregister
        """
        if extractor_id in self._extractors:
            del self._extractors[extractor_id]

    def list_extractors(self, input_filter: List[str] = None, output_filter: List[str] = None,
                        available_only: bool = True) -> List[Dict[str, Any]]:
        """
        List available extractors with optional filtering.

        Args:
            input_filter: Only include extractors that support these input types
            output_filter: Only include extractors that support these output types
            available_only: Only include extractors that are currently available

        Returns:
            List of extractor info dictionaries
        """
        extractors = []

        for extractor_id, extractor_class in self._extractors.items():
            # Check availability if requested
            if available_only and not extractor_class.is_available():
                continue

            try:
                extractor_info = extractor_class.get_info()
                if extractor_info is None:
                    logger.warning(f"{extractor_class.__name__}.get_info() returned None in list_extractors")
                    continue
            except Exception as e:
                logger.warning(f"Error calling {extractor_class.__name__}.get_info() in list_extractors: {e}")
                continue

            # Apply input filter
            if input_filter:
                if not any(inp in extractor_info.get('input', []) for inp in input_filter):
                    continue

            # Apply output filter
            if output_filter:
                if not any(out in extractor_info.get('output', []) for out in output_filter):
                    continue

            extractors.append(extractor_info)

        return extractors

    def get_extractor(self, extractor_id: str) -> Type[BaseExtractor]:
        """
        Get an extractor class by ID.

        Args:
            extractor_id: The ID of the extractor

        Returns:
            The extractor class

        Raises:
            KeyError: If extractor is not found
            RuntimeError: If extractor is not available
        """
        if extractor_id not in self._extractors:
            raise KeyError(f"Extractor '{extractor_id}' not found")

        extractor_class = self._extractors[extractor_id]

        if not extractor_class.is_available():
            raise RuntimeError(f"Extractor '{extractor_id}' is not available")

        return extractor_class

    def create_extractor(self, extractor_id: str) -> BaseExtractor:
        """
        Create an instance of an extractor.

        Args:
            extractor_id: The ID of the extractor

        Returns:
            An instance of the extractor
        """
        extractor_class = self.get_extractor(extractor_id)
        return extractor_class()


def list_extractors(**kwargs) -> List[Dict[str, Any]]:
    """Convenience function to list extractors."""
    return ExtractorRegistry.get_instance().list_extractors(**kwargs)


def get_extractor(extractor_id: str) -> Type[BaseExtractor]:
    """Convenience function to get an extractor class."""
    return ExtractorRegistry.get_instance().get_extractor(extractor_id)


def create_extractor(extractor_id: str) -> BaseExtractor:
    """Convenience function to create an extractor instance."""
    return ExtractorRegistry.get_instance().create_extractor(extractor_id)
