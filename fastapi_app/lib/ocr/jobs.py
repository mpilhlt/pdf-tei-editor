"""
Store of background OCR jobs.

The production server runs several worker processes, and the request that polls a job can be
handled by another worker than the one running it. Jobs are therefore stored as JSON files in a
directory that all workers share, not in memory. The same directory holds two lock files:

- the store lock makes checking for a running job of a PDF and creating a new one atomic
- the run lock lets only one OCR run happen at a time on the server, since OCR uses all cores
"""

import asyncio
import os
import secrets
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator, Optional

from fastapi_app.lib.models.models_ocr import OcrJob, OcrJobStatus, OcrResponse
from fastapi_app.lib.utils.file_lock import NonBlockingFileLock, exclusive_file_lock

JOB_MAX_AGE_SECONDS = 24 * 3600
"""Finished and abandoned jobs are deleted after this time."""

RUN_LOCK_POLL_SECONDS = 1.0
"""Interval at which a queued job checks whether the run lock is free."""

INTERRUPTED_MESSAGE = "Text recognition was interrupted because the server restarted. Please try again."

ACTIVE_STATUSES: tuple[OcrJobStatus, ...] = ("queued", "running")


class OcrJobConflict(Exception):
    """A job for the PDF is already queued or running."""

    def __init__(self, job: OcrJob):
        super().__init__(f"Text recognition is already {job.status} for this document")
        self.job = job


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _process_alive(pid: int) -> bool:
    """Return whether a process with this id exists."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        # Windows raises OSError for processes that do not exist
        return False
    return True


class OcrJobStore:
    """Creates, updates and reads OCR jobs stored as JSON files."""

    def __init__(self, directory: Path, poll_seconds: float = RUN_LOCK_POLL_SECONDS):
        self.directory = directory
        self.poll_seconds = poll_seconds

    def _path(self, job_id: str) -> Path:
        return self.directory / f"{job_id}.json"

    def _write(self, job: OcrJob) -> None:
        """Write a job atomically, so that a concurrent reader never sees a partial file."""
        self.directory.mkdir(parents=True, exist_ok=True)
        tmp = self.directory / f".{job.job_id}.{os.getpid()}.tmp"
        tmp.write_text(job.model_dump_json(), encoding="utf-8")
        os.replace(tmp, self._path(job.job_id))

    def create(self, stable_id: str, username: str) -> OcrJob:
        """
        Create a queued job in the current process and delete old jobs.

        Raises:
            OcrJobConflict: if a job for this PDF is already queued or running
        """
        with exclusive_file_lock(self.directory / ".store.lock"):
            self.cleanup()
            active = self.find_active(stable_id)
            if active is not None:
                raise OcrJobConflict(active)
            now = _now()
            job = OcrJob(
                job_id=secrets.token_urlsafe(12),
                stable_id=stable_id,
                status="queued",
                result=None,
                error=None,
                error_status=None,
                username=username,
                pid=os.getpid(),
                created_at=now,
                updated_at=now,
            )
            self._write(job)
            return job

    def find_active(self, stable_id: str) -> Optional[OcrJob]:
        """Return the queued or running job of a PDF, if there is one."""
        if not self.directory.exists():
            return None
        for path in self.directory.glob("*.json"):
            job = self.get(path.stem)
            if job is not None and job.stable_id == stable_id and job.status in ACTIVE_STATUSES:
                return job
        return None

    @asynccontextmanager
    async def run_slot(self, job: OcrJob) -> AsyncIterator[OcrJob]:
        """
        Wait until no other OCR run happens on the server, then mark the job as running.

        Yields:
            The job with the status 'running'
        """
        lock = NonBlockingFileLock(self.directory / ".run.lock")
        while not lock.try_acquire():
            await asyncio.sleep(self.poll_seconds)
        try:
            yield self._set_status(job, "running")
        finally:
            lock.release()

    def finish(self, job: OcrJob, result: OcrResponse) -> OcrJob:
        """Record the result of a job."""
        return self._set_status(job, "done", result=result)

    def fail(self, job: OcrJob, error: str, error_status: int = 500) -> OcrJob:
        """Record the failure of a job."""
        return self._set_status(job, "failed", error=error, error_status=error_status)

    def _set_status(self, job: OcrJob, status: OcrJobStatus, result: Optional[OcrResponse] = None, error: Optional[str] = None, error_status: Optional[int] = None) -> OcrJob:
        updated = job.model_copy(update={"status": status, "result": result, "error": error, "error_status": error_status, "updated_at": _now()})
        self._write(updated)
        return updated

    def get(self, job_id: str) -> Optional[OcrJob]:
        """
        Return a job, or None if there is no such job.

        A queued or running job whose process no longer exists (the worker was restarted) is
        marked as failed.
        """
        if not job_id or "/" in job_id or "\\" in job_id or job_id.startswith("."):
            return None
        path = self._path(job_id)
        try:
            job = OcrJob.model_validate_json(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        if job.status in ACTIVE_STATUSES and not _process_alive(job.pid):
            job = self.fail(job, INTERRUPTED_MESSAGE, 503)
        return job

    def cleanup(self, max_age: float = JOB_MAX_AGE_SECONDS) -> None:
        """Delete job files older than max_age seconds. Active jobs are kept."""
        if not self.directory.exists():
            return
        limit = time.time() - max_age
        for path in self.directory.glob("*.json"):
            try:
                if path.stat().st_mtime >= limit:
                    continue
                job = self.get(path.stem)
                if job is None or job.status not in ACTIVE_STATUSES:
                    path.unlink()
            except (FileNotFoundError, ValueError):
                path.unlink(missing_ok=True)
