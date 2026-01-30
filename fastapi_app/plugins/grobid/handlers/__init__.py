"""GROBID API endpoint handlers."""

from fastapi_app.plugins.grobid.handlers.base import GrobidHandler
from fastapi_app.plugins.grobid.handlers.training import TrainingHandler
from fastapi_app.plugins.grobid.handlers.fulltext import FulltextHandler
from fastapi_app.plugins.grobid.handlers.references import ReferencesHandler

__all__ = [
    "GrobidHandler",
    "TrainingHandler",
    "FulltextHandler",
    "ReferencesHandler",
]
