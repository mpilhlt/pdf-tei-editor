from .plugin import WebDavSyncPlugin
from .routes import router

plugin = WebDavSyncPlugin()

__all__ = ["WebDavSyncPlugin", "router", "plugin"]
