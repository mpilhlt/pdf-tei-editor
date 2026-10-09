from .plugin import RevisionFeedPlugin
from .routes import router

plugin = RevisionFeedPlugin()

__all__ = ["RevisionFeedPlugin", "router"]
