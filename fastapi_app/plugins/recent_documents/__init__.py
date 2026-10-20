from .plugin import RecentDocumentsPlugin
from .routes import router

plugin = RecentDocumentsPlugin()

__all__ = ["RecentDocumentsPlugin", "router"]
