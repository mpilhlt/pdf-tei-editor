from .plugin import MetadataExtractionPlugin
from .routes import router

plugin = MetadataExtractionPlugin()

__all__ = ["MetadataExtractionPlugin", "router"]
