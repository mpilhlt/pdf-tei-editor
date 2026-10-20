from .plugin import ReviewQueuePlugin
from .routes import router

plugin = ReviewQueuePlugin()

__all__ = ["ReviewQueuePlugin", "router"]
