"""
Plugin system for extending application functionality.

Provides plugin discovery, registration, and lifecycle management.
"""

from fastapi_app.lib.plugins.plugin_base import Plugin, PluginContext
from fastapi_app.lib.plugins.plugin_registry import PluginRegistry
from fastapi_app.lib.plugins.plugin_manager import PluginManager

__all__ = ["Plugin", "PluginContext", "PluginRegistry", "PluginManager"]
