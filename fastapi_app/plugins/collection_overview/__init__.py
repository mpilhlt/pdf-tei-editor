from .plugin import CollectionOverviewPlugin
from .routes import router

plugin = CollectionOverviewPlugin()

__all__ = ["CollectionOverviewPlugin", "router"]
