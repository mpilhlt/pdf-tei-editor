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

from fastapi_jobqueue import Job, JobHooks, ResourceBusy

from fastapi_app.config import get_settings
from fastapi_app.lib.core.locking import acquire_lock, register_lock_holder, release_lock
from fastapi_app.lib.utils.logging_utils import get_logger

from .files import file_resource_ids, files_input_hash, job_output_path

logger = get_logger(__name__)

JOB_LOCK_HOLDER_PREFIX = "job:"

LOCK_REFRESH_INTERVAL = 30.0
"""Seconds between refreshes of the locks of waiting jobs; well below LOCK_TIMEOUT_SECONDS."""

register_lock_holder(JOB_LOCK_HOLDER_PREFIX, "This document is locked while a background job runs on it.")


def job_lock_holder(job: Job) -> str:
    """The session id under which a job holds its file locks."""
    return f"{JOB_LOCK_HOLDER_PREFIX}{job.id}"


class EditorJobHooks(JobHooks):
    """Locks the files of a job's `file:` resources while the job is unfinished, and removes its output when it is deleted."""

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


@asynccontextmanager
async def job_lock_refresher(interval: float = LOCK_REFRESH_INTERVAL) -> AsyncIterator[None]:
    """Refresh the locks of waiting jobs every `interval` seconds while the context is open (the app lifespan)."""
    async def run() -> None:
        while True:
            await asyncio.sleep(interval)
            try:
                await refresh_waiting_job_locks()
            except Exception:
                logger.exception("Could not refresh the locks of waiting jobs")

    task = asyncio.create_task(run(), name="job-lock-refresher")
    try:
        yield
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
