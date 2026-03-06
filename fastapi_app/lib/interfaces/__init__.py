"""
Abstract base classes and interfaces for the PDF-TEI Editor library.

This module provides the contracts that implementations must follow,
enabling loose coupling and easier testing through dependency injection.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Type
from pathlib import Path


class Repository(ABC):
    """
    Abstract base class for data repositories.

    Repositories are responsible for data access and persistence.
    """

    @abstractmethod
    def get_by_id(self, id: str) -> Optional[Any]:
        """Retrieve an entity by its ID."""
        pass

    @abstractmethod
    def create(self, entity: Any) -> Any:
        """Create a new entity."""
        pass

    @abstractmethod
    def update(self, id: str, entity: Any) -> Any:
        """Update an existing entity."""
        pass

    @abstractmethod
    def delete(self, id: str) -> bool:
        """Delete an entity by its ID."""
        pass


class Service(ABC):
    """
    Abstract base class for business logic services.

    Services coordinate between repositories and implement business rules.
    """

    @abstractmethod
    def initialize(self) -> None:
        """Initialize the service."""
        pass

    @abstractmethod
    def cleanup(self) -> None:
        """Clean up resources."""
        pass


class Extractor(ABC):
    """
    Abstract base class for extraction engines.

    Extractors process input files and produce output in a specific format.
    """

    @property
    @abstractmethod
    def id(self) -> str:
        """Unique identifier for this extractor."""
        pass

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable name for this extractor."""
        pass

    @property
    @abstractmethod
    def description(self) -> str:
        """Description of what this extractor does."""
        pass

    @property
    @abstractmethod
    def input_types(self) -> List[str]:
        """List of supported input types (e.g., ['pdf'], ['xml'])."""
        pass

    @property
    @abstractmethod
    def output_types(self) -> List[str]:
        """List of supported output types (e.g., ['xml'])."""
        pass

    @abstractmethod
    def is_available(self) -> bool:
        """Check if this extractor is currently available."""
        pass

    @abstractmethod
    async def extract(self, input_path: Path, **kwargs) -> Any:
        """Perform extraction on the input file."""
        pass


class Plugin(ABC):
    """
    Abstract base class for plugins.

    Plugins extend the application's functionality through hooks and endpoints.
    """

    @property
    @abstractmethod
    def id(self) -> str:
        """Unique identifier for this plugin."""
        pass

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable name for this plugin."""
        pass

    @property
    @abstractmethod
    def version(self) -> str:
        """Version of this plugin."""
        pass

    @abstractmethod
    async def initialize(self, context: Any) -> None:
        """Initialize the plugin with the given context."""
        pass

    @abstractmethod
    async def cleanup(self) -> None:
        """Clean up plugin resources."""
        pass

    @classmethod
    @abstractmethod
    def is_available(cls) -> bool:
        """Check if this plugin is available (dependencies met)."""
        pass


__all__ = [
    "Repository",
    "Service",
    "Extractor",
    "Plugin",
]
