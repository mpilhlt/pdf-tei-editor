"""
Utility functions and helpers.

Provides common utilities used across the application.
"""

from fastapi_app.lib.utils.config_utils import get_config
from fastapi_app.lib.utils.stable_id import generate_stable_id

__all__ = ["get_config", "generate_stable_id"]
