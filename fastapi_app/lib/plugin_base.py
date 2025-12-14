"""
Base classes for the backend plugin system.

This module provides the abstract base class for plugins and the context object
that plugins receive for interacting with the application.
"""

from abc import ABC, abstractmethod
from typing import Any, Callable


class PluginContext:
    """
    Context object providing controlled access to application services for plugins.

    This facade pattern prevents tight coupling between plugins and the application.
    Plugins should only interact with the application through this context.
    """

    def __init__(self, app: Any = None, user: dict | None = None):
        """
        Initialize plugin context.

        Args:
            app: FastAPI application instance
            user: Current user dict with roles, if authenticated
        """
        self._app = app
        self._user = user

    @property
    def app(self) -> Any:
        """Get the FastAPI application instance."""
        return self._app

    @property
    def user(self) -> dict | None:
        """Get the current user."""
        return self._user


class Plugin(ABC):
    """
    Abstract base class for all backend plugins.

    Plugins must implement the metadata property and get_endpoints method.
    Lifecycle hooks (initialize, cleanup) are optional.
    """

    @property
    @abstractmethod
    def metadata(self) -> dict[str, Any]:
        """
        Return plugin metadata.

        Required fields:
            - id (str): Unique plugin identifier (alphanumeric + hyphens)
            - name (str): Human-readable plugin name
            - description (str): Brief description of plugin functionality
            - category (str): Plugin category (e.g., "analyzer", "exporter")
            - version (str): Plugin version (semver recommended)
            - required_roles (list[str]): Roles required to access plugin (empty = all users)

        Returns:
            dict: Plugin metadata
        """
        pass

    @abstractmethod
    def get_endpoints(self) -> dict[str, Callable]:
        """
        Return mapping of endpoint names to callable methods.

        Example:
            {
                "execute": self.execute,
                "validate": self.validate
            }

        Returns:
            dict: Mapping of endpoint names to bound methods
        """
        pass

    async def initialize(self, context: PluginContext) -> None:
        """
        Optional initialization hook called when plugin is loaded.

        Args:
            context: Plugin context for accessing application services
        """
        pass

    async def cleanup(self) -> None:
        """
        Optional cleanup hook called on application shutdown.
        """
        pass
