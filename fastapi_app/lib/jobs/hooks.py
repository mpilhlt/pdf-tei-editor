"""
Hooks that map the `file:<stable_id>` resources of jobs to the editor's file locks.

A job holds the locks under the holder id `job:<job id>`, so the editor shows the registered
notice to users who open a file while a job runs on it.
"""

from __future__ import annotations

import asyncio
import shutil

from fastapi_jobqueue import Job, JobHooks, ResourceBusy

from fastapi_app.config import get_settings
from fastapi_app.lib.core.locking import acquire_lock, register_lock_holder, release_lock
from fastapi_app.lib.utils.logging_utils import get_logger

from .files import file_resource_ids, files_input_hash, job_output_path

logger = get_logger(__name__)

JOB_LOCK_HOLDER_PREFIX = "job:"

register_lock_holder(JOB_LOCK_HOLDER_PREFIX, "This document is locked while a background job runs on it.")


def job_lock_holder(job: Job) -> str:
    """The session id under which a job holds its file locks."""
    return f"{JOB_LOCK_HOLDER_PREFIX}{job.id}"


class EditorJobHooks(JobHooks):
    """Locks the files of a job's `file:` resources while the job is unfinished, and removes its output when it is deleted."""

    async def acquire(self, job: Job) -> None:
        await asyncio.to_thread(self._acquire, job)

    async def renew(self, job: Job) -> None:
        await asyncio.to_thread(self._renew, job)

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
    def _renew(job: Job) -> None:
        db_dir = get_settings().db_dir
        holder = job_lock_holder(job)
        for stable_id in file_resource_ids(job.resources):
            try:
                if not acquire_lock(stable_id, holder, db_dir, logger):
                    logger.warning(f"Job {job.id} lost the lock of {stable_id}")
            except Exception:
                logger.exception(f"Could not renew the lock of {stable_id} for job {job.id}")

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
