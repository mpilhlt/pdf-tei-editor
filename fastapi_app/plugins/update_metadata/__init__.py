"""
Update Metadata Plugin

Updates TEI documents with complete bibliographic metadata from DOI lookup.
"""

from .plugin import UpdateMetadataPlugin
from .routes import router

plugin = UpdateMetadataPlugin()

__all__ = ["UpdateMetadataPlugin", "plugin", "router"]
