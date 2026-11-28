"""
Hooks that map the `file:<stable_id>` resources of jobs to the editor's file locks.

A job holds the locks under the holder id `job:<job id>`, so the editor shows the registered
notice to users who open a file while a job runs on it. The library renews the locks of active
jobs with their lease; `job_lock_refresher` refreshes those of waiting (queued or interrupted)
jobs, which have no lease.
"""

from __future__ import annotations

import asyncio
import shutil
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from typing import Any

from fastapi_jobqueue import Job, JobHooks, ResourceBusy
from fastapi_jobqueue.errors import JobQueueError, PermissionDenied

from fastapi_app.config import get_settings
from fastapi_app.lib.core.dependencies import get_db
from fastapi_app.lib.core.locking import LOCAL_LOCK_PREFIX, acquire_lock, register_lock_holder, release_lock
from fastapi_app.lib.permissions.access_control import check_file_access
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.utils.logging_utils import get_logger

from .auth import job_user
from .files import file_resource_ids, files_input_hash, job_output_path

logger = get_logger(__name__)

JOB_LOCK_HOLDER_PREFIX = "job:"

LOCK_REFRESH_INTERVAL = 30.0
"""Seconds between refreshes of the locks of waiting jobs; well below LOCK_TIMEOUT_SECONDS."""

UNCLAIMED_CLIENT_JOB_MAX_AGE = 300.0
"""Seconds after which a client job that no client has claimed (`queued`) is cancelled; such a job has no lease and would never end."""

register_lock_holder(JOB_LOCK_HOLDER_PREFIX, "This document is locked while a background job runs on it.")


def _file_repository() -> FileRepository:
    """The file repository of the hooks, which run outside of a request (patched by tests)."""
    return FileRepository(get_db())


class InvalidResource(JobQueueError):
    """A `file:` resource of a submitted job that names no file, or a lock that is not a file's (400)."""

    status_code = 400


def check_file_resources(job: Job) -> None:
    """
    Check that the owner of a job may lock the files of its `file:` resources: each one names an
    existing file (not a local resource such as the OCR engine lock) that the owner may edit.

    Raises:
        InvalidResource: for a `local:` id or a file that does not exist (400 on submit)
        PermissionDenied: if the owner no longer exists or may not edit a file (403 on submit)
    """
    stable_ids = file_resource_ids(job.resources)
    if not stable_ids:
        return
    try:
        user: dict[str, Any] = job_user(job)
    except PermissionError as e:
        raise PermissionDenied(str(e)) from e
    repo = _file_repository()
    for stable_id in stable_ids:
        if stable_id.startswith(LOCAL_LOCK_PREFIX):
            raise InvalidResource(f"file:{stable_id} is not a file")
        file = repo.get_file_by_stable_id(stable_id)
        if file is None:
            raise InvalidResource(f"File not found: {stable_id}")
        if not check_file_access(file, user, "edit"):
            raise PermissionDenied(f"Not allowed to lock {stable_id}")


def job_lock_holder(job: Job) -> str:
    """The session id under which a job holds its file locks."""
    return f"{JOB_LOCK_HOLDER_PREFIX}{job.id}"


class EditorJobHooks(JobHooks):
    """
    Locks the files of a job's `file:` resources while the job is unfinished (after checking that
    its owner may edit them, see `check_file_resources`), and removes its output when it is deleted.
    """

    async def acquire(self, job: Job) -> None:
        await asyncio.to_thread(self._acquire, job)

    async def renew(self, job: Job) -> None:
        lost = await asyncio.to_thread(refresh_job_locks, job)
        if lost and job.status == "active":
            # Another holder has the file now, so the job must not write it
            logger.warning(f"Job {job.id} lost the lock of {', '.join(lost)} to another holder; cancelling it")
            from .manager import get_job_manager
            await get_job_manager().cancel(job.id)

    async def release(self, job: Job) -> None:
        await asyncio.to_thread(self._release, job)

    async def input_changed(self, job: Job) -> bool:
        if job.input_hash is None or not file_resource_ids(job.resources):
            return False
        return await asyncio.to_thread(files_input_hash, job.resources) != job.input_hash

    def deleted(self, job: Job) -> None:
        # The library propagates exceptions of this hook after the row is gone, so it must not raise
        try:
            shutil.rmtree(job_output_path(job.id), ignore_errors=True)
        except Exception:
            logger.exception(f"Could not remove the output of job {job.id}")

    @staticmethod
    def _acquire(job: Job) -> None:
        check_file_resources(job)
        db_dir = get_settings().db_dir
        holder = job_lock_holder(job)
        taken: list[str] = []
        try:
            for stable_id in file_resource_ids(job.resources):
                if not acquire_lock(stable_id, holder, db_dir, logger):
                    raise ResourceBusy(f"{stable_id} is being edited by another user or job")
                taken.append(stable_id)
        except BaseException:
            for stable_id in taken:
                EditorJobHooks._release_one(stable_id, holder)
            raise

    @staticmethod
    def _release(job: Job) -> None:
        holder = job_lock_holder(job)
        for stable_id in file_resource_ids(job.resources):
            EditorJobHooks._release_one(stable_id, holder)

    @staticmethod
    def _release_one(stable_id: str, holder: str) -> None:
        try:
            release_lock(stable_id, holder, get_settings().db_dir, logger)
        except Exception as e:
            logger.warning(f"Could not release the lock of {stable_id} held by {holder}: {e}")


def refresh_job_locks(job: Job) -> list[str]:
    """Refresh the file locks of a job (blocking); returns the stable ids whose lock another holder has."""
    db_dir = get_settings().db_dir
    holder = job_lock_holder(job)
    lost: list[str] = []
    for stable_id in file_resource_ids(job.resources):
        try:
            if not acquire_lock(stable_id, holder, db_dir, logger):
                lost.append(stable_id)
        except Exception:
            logger.exception(f"Could not renew the lock of {stable_id} for job {job.id}")
    return lost


async def refresh_waiting_job_locks() -> None:
    """Refresh the file locks of the queued and interrupted jobs, which the library does not renew."""
    from .manager import get_job_manager
    for job in await get_job_manager().list(statuses=("queued", "interrupted")):
        if not file_resource_ids(job.resources):
            continue
        lost = await asyncio.to_thread(refresh_job_locks, job)
        if lost:
            logger.warning(f"Waiting job {job.id} lost the lock of {', '.join(lost)} to another holder")


async def cancel_unclaimed_client_jobs(max_age: float = UNCLAIMED_CLIENT_JOB_MAX_AGE) -> int:
    """
    Cancel the client jobs that were created more than `max_age` seconds ago and are still `queued`
    (no client claimed them, e.g. because the browser closed before the request of a request-driven job).

    Returns:
        The number of jobs cancelled
    """
    from .manager import get_job_manager
    manager = get_job_manager()
    now = manager.clock()
    count = 0
    for job in await manager.list(statuses=("queued",)):
        if job.driver != "client" or now - job.created_at.timestamp() <= max_age:
            continue
        # one job that cannot be cancelled must not keep the others queued
        try:
            await manager.cancel(job.id)
        except Exception:
            logger.exception(f"Could not cancel the unclaimed client job {job.id} ({job.type})")
            continue
        logger.info(f"Cancelled client job {job.id} ({job.type}), which was not claimed within {max_age:.0f} s")
        count += 1
    return count


@asynccontextmanager
async def job_lock_refresher(interval: float = LOCK_REFRESH_INTERVAL) -> AsyncIterator[None]:
    """
    Every `interval` seconds while the context is open (the app lifespan), refresh the locks of
    waiting jobs and cancel client jobs that stay unclaimed.
    """
    async def run() -> None:
        while True:
            await asyncio.sleep(interval)
            try:
                await refresh_waiting_job_locks()
            except Exception:
                logger.exception("Could not refresh the locks of waiting jobs")
            try:
                await cancel_unclaimed_client_jobs()
            except Exception:
                logger.exception("Could not cancel unclaimed client jobs")

    task = asyncio.create_task(run(), name="job-lock-refresher")
    try:
        yield
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
