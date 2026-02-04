"""KISSKI extractor plugin."""

from .plugin import KisskiPlugin
from .routes import router

__all__ = ["KisskiPlugin", "router"]
