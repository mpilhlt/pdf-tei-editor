"""
Deprecated garbage-collection hooks for plugins; use :mod:`fastapi_app.lib.core.gc_registry`.

``register_gc_handler`` wraps a handler that returns the number of deleted items into a task of
the GC registry (id ``plugin:<plugin_id>``, order 850), so plugins written against it keep working.
"""

from collections.abc import Callable

from .gc_registry import GcContext, GcResult, clear_directory, register_gc_task, unregister_gc_task

__all__ = ["GcHandler", "clear_directory", "plugin_task_id", "register_gc_handler", "unregister_gc_handler"]

GcHandler = Callable[[], int]
"""A handler deletes reproducible plugin data and returns the number of deleted items."""

PLUGIN_TASK_PREFIX = "plugin:"
PLUGIN_TASK_ORDER = 850


def plugin_task_id(plugin_id: str) -> str:
    """Id of the GC task of a plugin registered through :func:`register_gc_handler`."""
    return PLUGIN_TASK_PREFIX + plugin_id


def register_gc_handler(plugin_id: str, handler: GcHandler) -> None:
    """
    Register a garbage-collection handler for a plugin (deprecated: use ``register_gc_task``).

    The handler cannot report sizes and does not support dry runs.

    Args:
        plugin_id: Id of the plugin that owns the data
        handler: Function that deletes the data and returns the number of deleted items
    """

    def task(context: GcContext) -> GcResult:
        return GcResult(items_deleted=handler())

    register_gc_task(
        plugin_task_id(plugin_id), f"Plugin data: {plugin_id}", task, order=PLUGIN_TASK_ORDER, supports_dry_run=False
    )


def unregister_gc_handler(plugin_id: str) -> None:
    """Remove the garbage-collection handler of a plugin (e.g. on plugin cleanup)."""
    unregister_gc_task(plugin_task_id(plugin_id))
