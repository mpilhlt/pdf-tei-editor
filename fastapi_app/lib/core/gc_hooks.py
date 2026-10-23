"""
Garbage-collection hooks for plugins.

Plugins that keep reproducible data (caches, derived files) register a handler
in ``initialize()`` and unregister it in ``cleanup()``. The garbage-collection
endpoint (``POST /api/v1/files/garbage_collect``) calls every registered
handler and reports the number of deleted items per plugin.
"""

import logging
import shutil
from collections.abc import Callable
from pathlib import Path

logger = logging.getLogger(__name__)

GcHandler = Callable[[], int]
"""A handler deletes reproducible plugin data and returns the number of deleted items."""

_handlers: dict[str, GcHandler] = {}


def register_gc_handler(plugin_id: str, handler: GcHandler) -> None:
    """
    Register a garbage-collection handler for a plugin.

    Args:
        plugin_id: Id of the plugin that owns the data
        handler: Function that deletes the data and returns the number of deleted items
    """
    _handlers[plugin_id] = handler


def unregister_gc_handler(plugin_id: str) -> None:
    """Remove the garbage-collection handler of a plugin (e.g. on plugin cleanup)."""
    _handlers.pop(plugin_id, None)


def run_gc_handlers() -> dict[str, int]:
    """
    Run all registered garbage-collection handlers.

    A failing handler is logged and reported with 0 deleted items; it does not
    stop the other handlers.

    Returns:
        Number of deleted items by plugin id
    """
    results: dict[str, int] = {}
    for plugin_id, handler in list(_handlers.items()):
        try:
            results[plugin_id] = handler()
        except Exception as e:
            logger.error(f"Garbage-collection handler of plugin {plugin_id} failed: {e}", exc_info=True)
            results[plugin_id] = 0
    return results


def clear_directory(directory: Path) -> int:
    """
    Delete all files and subdirectories of a directory, keeping the directory itself.

    Helper for garbage-collection handlers.

    Args:
        directory: Directory to empty; nothing happens if it does not exist

    Returns:
        Number of deleted top-level entries
    """
    if not directory.is_dir():
        return 0
    deleted = 0
    for item in directory.iterdir():
        try:
            if item.is_dir() and not item.is_symlink():
                shutil.rmtree(item)
            else:
                item.unlink()
            deleted += 1
        except OSError as e:
            logger.warning(f"Failed to delete {item}: {e}")
    return deleted
