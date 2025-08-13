"""
Cache manager for file data caching and invalidation.
Provides a simple dirty flag mechanism to track when filesystem changes require cache refresh.
"""

import time
from datetime import datetime, timezone
from pathlib import Path
from flask import current_app

# Global cache status
_cache_status = {
    "dirty": False,
    "last_modified": None,
    "last_checked": None,
    "last_synced": None,
    "sync_needed": False,
    "sync_last_needed": None
}

def mark_cache_dirty():
    """Mark the file data cache as dirty (needs refresh)."""
    global _cache_status
    _cache_status["dirty"] = True
    _cache_status["last_modified"] = datetime.now(timezone.utc).isoformat()
    current_app.logger.debug("File data cache marked as dirty")

def is_cache_dirty():
    """Check if the file data cache is dirty."""
    return _cache_status["dirty"]

def mark_cache_clean():
    """Mark the file data cache as clean (up to date)."""
    global _cache_status
    _cache_status["dirty"] = False
    _cache_status["last_checked"] = datetime.now(timezone.utc).isoformat()
    current_app.logger.debug("File data cache marked as clean")

def get_cache_status():
    """Get the current cache status for API responses."""
    return {
        "dirty": _cache_status["dirty"],
        "last_modified": _cache_status.get("last_modified"),
        "last_checked": _cache_status.get("last_checked")
    }

def get_last_modified_datetime():
    """Get the last modified timestamp as a datetime object."""
    if _cache_status.get("last_modified"):
        return datetime.fromisoformat(_cache_status["last_modified"])
    return None

def mark_last_synced():
    """Mark when the last sync completed successfully."""
    global _cache_status
    _cache_status["last_synced"] = datetime.now(timezone.utc).isoformat()
    current_app.logger.debug("Last sync timestamp updated")

def get_last_synced_datetime():
    """Get the last synced timestamp as a datetime object."""
    if _cache_status.get("last_synced"):
        return datetime.fromisoformat(_cache_status["last_synced"])
    return None

def mark_sync_needed():
    """Mark that files need sync (called when files are saved/changed)."""
    global _cache_status
    _cache_status["sync_needed"] = True
    _cache_status["sync_last_needed"] = datetime.now(timezone.utc).isoformat()
    current_app.logger.debug("Sync marked as needed")

def is_sync_needed():
    """Check if sync is needed (fast - just checks flag)."""
    return _cache_status["sync_needed"]

def mark_sync_completed():
    """Mark sync as completed (called only after successful sync)."""
    global _cache_status
    _cache_status["sync_needed"] = False
    _cache_status["last_synced"] = datetime.now(timezone.utc).isoformat()
    current_app.logger.debug("Sync marked as completed")

def get_sync_last_needed_datetime():
    """Get the timestamp when sync was last marked as needed."""
    if _cache_status.get("sync_last_needed"):
        return datetime.fromisoformat(_cache_status["sync_last_needed"])
    return None

def reset_cache_status():
    """Reset cache status (for testing purposes)."""
    global _cache_status
    _cache_status = {
        "dirty": False,
        "last_modified": None,
        "last_checked": None,
        "last_synced": None,
        "sync_needed": False,
        "sync_last_needed": None
    }