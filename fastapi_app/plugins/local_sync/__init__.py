"""Local Sync plugin initialization.

Note: This __init__.py is NOT executed during plugin discovery.
Plugins are loaded directly from plugin.py via importlib.
Configuration initialization happens in the plugin class is_available() method.
"""

from .plugin import LocalSyncPlugin

plugin = LocalSyncPlugin()
