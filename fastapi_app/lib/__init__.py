"""
Library module exports for PDF-TEI-Editor.

Provides convenient access to commonly used utilities.
"""

from .config_utils import get_config

# Preconfigured config instance
# Usage: from fastapi_app.lib import config
config = get_config()
