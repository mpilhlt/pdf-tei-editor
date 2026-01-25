"""
Frontend Extension Registry.

Central registry for JavaScript extension files that extend frontend functionality.
Backend plugins register extensions during initialization.
"""

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


class FrontendExtensionRegistry:
    """Singleton registry for frontend extensions."""

    _instance = None

    def __init__(self):
        self._extension_files: list[tuple[Path, str]] = []

    @classmethod
    def get_instance(cls) -> "FrontendExtensionRegistry":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Reset singleton for testing."""
        cls._instance = None

    def register_extension(self, file_path: Path, plugin_id: str) -> None:
        """Register an extension file from a plugin."""
        if not file_path.exists():
            logger.warning(f"Extension file not found: {file_path}")
            return

        existing = [f.name for f, _ in self._extension_files]
        if file_path.name in existing:
            logger.warning(
                f"Extension {file_path.name} already registered, "
                f"replacing with version from {plugin_id}"
            )
            self._extension_files = [
                (f, pid) for f, pid in self._extension_files
                if f.name != file_path.name
            ]

        self._extension_files.append((file_path, plugin_id))
        logger.info(f"Registered frontend extension: {file_path.name} from {plugin_id}")

    def get_extension_files(self) -> list[tuple[Path, str]]:
        """Return all registered extension files."""
        return self._extension_files.copy()

    def clear(self) -> None:
        """Clear all registered extensions."""
        self._extension_files.clear()
