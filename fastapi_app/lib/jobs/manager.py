"""
The job manager of this worker process.

`main.py` creates it at module level with `set_job_manager(create_job_manager())`, mounts its
routes and runs it in the app's lifespan. Tests create one on a `MemoryJobStore`.
"""

from __future__ import annotations

from fastapi_jobqueue import JobAuth, JobManager, SqliteJobStore

from fastapi_app.config import get_settings

from .auth import current_principal, may_submit_or_forbid
from .hooks import EditorJobHooks
from .registry import register_all_on_manager

_manager: JobManager | None = None


def create_job_manager(store: SqliteJobStore | None = None) -> JobManager:
    """
    Create a job manager with the editor's authentication and file-lock hooks, and register the
    known job types on it.

    Args:
        store: The job store; by default `jobs.db` in the database directory, shared by all workers
    """
    manager = JobManager(
        store if store is not None else SqliteJobStore(get_settings().db_dir / "jobs.db"),
        auth=JobAuth(current_principal=current_principal, may_submit=may_submit_or_forbid),
        hooks=EditorJobHooks(),
        retention=3600,
        resume_window=900,
    )
    register_all_on_manager(manager)
    return manager


def current_job_manager() -> JobManager | None:
    """The job manager, or None if none was set yet."""
    return _manager


def get_job_manager() -> JobManager:
    """
    The job manager of this process (also a FastAPI dependency).

    Raises:
        RuntimeError: if no manager was set
    """
    if _manager is None:
        raise RuntimeError("No job manager was set (set_job_manager)")
    return _manager


def set_job_manager(manager: JobManager) -> None:
    """Set the job manager of this process (main.py; tests)."""
    global _manager
    _manager = manager
