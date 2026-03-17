from .plugin import ActiveSessionsPlugin
from .routes import router

plugin = ActiveSessionsPlugin()

__all__ = ["ActiveSessionsPlugin", "router"]
