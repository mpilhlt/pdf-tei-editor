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

    def __init__(
        self,
        app: Any = None,
        user: dict | None = None,
        plugin_id: str | None = None,
        registry: Any = None,
    ):
        """
        Initialize plugin context.

        Args:
            app: FastAPI application instance
            user: Current user dict with roles, if authenticated
            plugin_id: ID of the plugin this context belongs to
            registry: Plugin registry for accessing dependencies
        """
        self._app = app
        self._user = user
        self._plugin_id = plugin_id
        self._registry = registry

    @property
    def app(self) -> Any:
        """Get the FastAPI application instance."""
        return self._app

    @property
    def user(self) -> dict | None:
        """Get the current user."""
        return self._user

    def get_dependency(self, dependency_id: str) -> "Plugin | None":
        """
        Get a declared dependency plugin instance.

        Args:
            dependency_id: ID of the dependency plugin to retrieve

        Returns:
            Plugin instance or None if not a declared dependency
        """
        if not self._registry or not self._plugin_id:
            return None
        return self._registry.get_dependency(self._plugin_id, dependency_id)


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
            - category (str): Plugin category (e.g., "document", "exporter")
            - version (str): Plugin version (semver recommended)
            - required_roles (list[str]): Roles required to access plugin (empty = all users)

        Optional fields:
            - dependencies (list[str]): Plugin IDs this plugin depends on. Dependencies
              are loaded before this plugin and can be accessed via context.get_dependency().
            - endpoints (list[dict]): Menu endpoint definitions for multi-endpoint plugins
              Each endpoint definition contains:
                - name (str): Endpoint method name (must match key in get_endpoints())
                - label (str): Display label for menu item
                - description (str): Optional description shown as tooltip
                - state_params (list[str]): Required frontend state fields to pass as parameters

              If not specified, defaults to single menu item calling 'execute' endpoint.
              If empty list, plugin appears in list but adds no menu items.

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

    @classmethod
    def is_available(cls) -> bool:
        """
        Check if the plugin is available for use.

        This allows plugins to depend on runtime conditions such as:
        - Environment variables (e.g., application mode)
        - External dependencies
        - Configuration settings
        - System capabilities

        Returns:
            bool: True if plugin is available, False otherwise
        """
        return True

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
