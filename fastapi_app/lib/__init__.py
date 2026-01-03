"""
Library module exports for PDF-TEI-Editor.

Provides convenient access to commonly used utilities.

Note: The config instance is not initialized at module import time
to avoid circular import issues when bin/manage.py is called from
contexts where fastapi_app.config may not be in the Python path.

Usage:
    from fastapi_app.lib.config_utils import get_config
    config = get_config()
"""

# Re-export for convenience
from .config_utils import get_config

__all__ = ["get_config"]
