"""
Registry of garbage-collection tasks.

Each component that keeps data which can go stale (file records and storage, caches, the message
index, plugin data) registers a cleanup task at startup. ``POST /api/v1/files/garbage_collect``
builds a :class:`GcContext` and calls :func:`run_gc`, which runs the tasks by ``order`` (tasks with
the same order in registration order) and returns one :class:`GcTaskRun` per task.

A task returns a :class:`GcResult`. A failing task is logged and reported with its error; it does
not stop the other tasks. Tasks registered with ``supports_dry_run=False`` are skipped in a dry run.

Orders used by the core tasks (lower runs first):

- 100-199: purge of soft-deleted files
- 200-599: scans that depend on the purge (orphaned storage files, duplicates, collections, orphaned XML)
- 600-699: derived indexes (message index)
- 800-899: caches and plugin data (plugins registered through ``register_gc_handler`` use 850)
- 900-999: temporary files
"""

from __future__ import annotations

import logging
import shutil
import threading
from collections.abc import Callable, Collection
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from fastapi_app.lib.repository.file_repository import FileRepository
    from fastapi_app.lib.storage.file_storage import FileStorage

logger = logging.getLogger(__name__)

DEFAULT_ORDER = 500


@dataclass
class GcContext:
    """Parameters and resources of one garbage-collection run."""

    deleted_before: datetime
    """Soft-deleted files last updated before this time are purged."""
    file_repo: FileRepository
    file_storage: FileStorage
    db_dir: Path
    sync_status: str | None = None
    """Only purge soft-deleted files with this sync status."""
    is_admin: bool = False
    dry_run: bool = False
    """Report what would be deleted without deleting anything."""


@dataclass
class GcResult:
    """What one task deleted (or would delete in a dry run)."""

    items_deleted: int = 0
    bytes_freed: int = 0
    details: dict[str, int] = field(default_factory=dict)
    """Task-specific counts, e.g. ``{"records_purged": 3, "rows_updated": 2}``."""
    errors: list[str] = field(default_factory=list)
    skipped: bool = False
    """True if the task did not run (it does not support dry runs)."""


GcTask = Callable[[GcContext], GcResult]


@dataclass
class GcTaskInfo:
    """A registered task."""

    id: str
    label: str
    task: GcTask
    order: int
    supports_dry_run: bool
    seq: int


@dataclass
class GcTaskRun:
    """The result of one task in a run."""

    id: str
    label: str
    result: GcResult


_tasks: dict[str, GcTaskInfo] = {}
_tasks_lock = threading.Lock()
_seq = 0


def register_gc_task(
    task_id: str,
    label: str,
    task: GcTask,
    *,
    order: int = DEFAULT_ORDER,
    supports_dry_run: bool = True,
) -> None:
    """
    Register a garbage-collection task; registering an id again replaces the task but keeps its position.

    Args:
        task_id: Unique id, e.g. ``"schema-cache"`` or ``"plugin:grobid"``
        label: Human-readable name shown in the result dialog
        task: Function that deletes the data and reports what it deleted
        order: Position in the run; lower runs first, equal orders run in registration order
        supports_dry_run: If False, the task is skipped in a dry run. A task that supports dry runs
            must not delete anything when ``context.dry_run`` is True.
    """
    global _seq
    with _tasks_lock:
        existing = _tasks.get(task_id)
        if existing is not None:
            seq = existing.seq
        else:
            _seq += 1
            seq = _seq
        _tasks[task_id] = GcTaskInfo(task_id, label, task, order, supports_dry_run, seq)


def unregister_gc_task(task_id: str) -> None:
    """Remove a task (e.g. on plugin cleanup); does nothing if it is not registered."""
    with _tasks_lock:
        _tasks.pop(task_id, None)


def list_gc_tasks() -> list[GcTaskInfo]:
    """The registered tasks in run order."""
    with _tasks_lock:
        return sorted(_tasks.values(), key=lambda t: (t.order, t.seq))


def run_gc(context: GcContext, task_ids: Collection[str] | None = None) -> list[GcTaskRun]:
    """
    Run the registered tasks in order.

    Args:
        context: Parameters and resources of the run
        task_ids: Only run these tasks (all if None); unknown ids are ignored

    Returns:
        One entry per task that was selected, in run order
    """
    runs: list[GcTaskRun] = []
    for info in list_gc_tasks():
        if task_ids is not None and info.id not in task_ids:
            continue
        if context.dry_run and not info.supports_dry_run:
            logger.info(f"GC task {info.id}: skipped (no dry run)")
            runs.append(GcTaskRun(info.id, info.label, GcResult(skipped=True)))
            continue
        try:
            result = info.task(context)
        except Exception as e:
            logger.error(f"GC task {info.id} failed: {e}", exc_info=True)
            result = GcResult(errors=[str(e) or type(e).__name__])
        details = ", ".join(f"{k}={v}" for k, v in result.details.items())
        logger.info(
            f"GC task {info.id}{' (dry run)' if context.dry_run else ''}: {result.items_deleted} items, "
            f"{result.bytes_freed} bytes{', ' + details if details else ''}"
            f"{', ' + str(len(result.errors)) + ' errors' if result.errors else ''}"
        )
        runs.append(GcTaskRun(info.id, info.label, result))
    return runs


def _entry_size(path: Path) -> int:
    """Size of a file, or of all files below a directory."""
    try:
        if path.is_dir() and not path.is_symlink():
            return sum(p.stat().st_size for p in path.rglob("*") if p.is_file() and not p.is_symlink())
        return path.lstat().st_size
    except OSError:
        return 0


def clear_directory_result(directory: Path, dry_run: bool = False) -> GcResult:
    """
    Delete all entries of a directory, keeping the directory itself, and report counts and sizes.

    Helper for tasks that clear a cache directory.

    Args:
        directory: Directory to empty; nothing happens if it does not exist
        dry_run: Only count what would be deleted

    Returns:
        ``items_deleted`` is the number of top-level entries
    """
    result = GcResult()
    if not directory.is_dir():
        return result
    for item in directory.iterdir():
        size = _entry_size(item)
        if not dry_run:
            try:
                if item.is_dir() and not item.is_symlink():
                    shutil.rmtree(item)
                else:
                    item.unlink()
            except OSError as e:
                logger.warning(f"Failed to delete {item}: {e}")
                result.errors.append(f"{item.name}: {e}")
                continue
        result.items_deleted += 1
        result.bytes_freed += size
    return result


def clear_directory(directory: Path) -> int:
    """
    Delete all files and subdirectories of a directory, keeping the directory itself.

    Args:
        directory: Directory to empty; nothing happens if it does not exist

    Returns:
        Number of deleted top-level entries
    """
    return clear_directory_result(directory).items_deleted


def register_directory_gc_task(
    task_id: str,
    label: str,
    directory: Callable[[], Path],
    *,
    order: int = DEFAULT_ORDER,
) -> None:
    """
    Register a task that empties a directory of reproducible data.

    Args:
        task_id: Unique id
        label: Human-readable name
        directory: Returns the directory (resolved on every run)
        order: Position in the run
    """
    register_gc_task(task_id, label, lambda ctx: clear_directory_result(directory(), ctx.dry_run), order=order)
