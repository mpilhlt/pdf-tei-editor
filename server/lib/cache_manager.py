"""
Cache manager for file data caching and invalidation.
Provides a simple dirty flag mechanism to track when filesystem changes require cache refresh.
"""

import time
from pathlib import Path
from flask import current_app

# Global cache status
_cache_status = {
    "dirty": False,
    "last_modified": None,
    "last_checked": None
}

def mark_cache_dirty():
    """Mark the file data cache as dirty (needs refresh)."""
    global _cache_status
    _cache_status["dirty"] = True
    _cache_status["last_modified"] = time.time()
    current_app.logger.debug("File data cache marked as dirty")

def is_cache_dirty():
    """Check if the file data cache is dirty."""
    return _cache_status["dirty"]

def mark_cache_clean():
    """Mark the file data cache as clean (up to date)."""
    global _cache_status
    _cache_status["dirty"] = False
    _cache_status["last_checked"] = time.time()
    current_app.logger.debug("File data cache marked as clean")

def get_cache_status():
    """Get the current cache status for API responses."""
    return {
        "dirty": _cache_status["dirty"],
        "last_modified": _cache_status.get("last_modified"),
        "last_checked": _cache_status.get("last_checked")
    }

def reset_cache_status():
    """Reset cache status (for testing purposes)."""
    global _cache_status
    _cache_status = {
        "dirty": False,
        "last_modified": None,
        "last_checked": None
    }