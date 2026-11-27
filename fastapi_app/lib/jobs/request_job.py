"""
Jobs that are driven by the request that does their work.

A route that needs the user's session (e.g. OCR text corrections) cannot run as a server job.
The client submits a client job, passes its id to the route, and the route runs inside
`run_request_job`, which holds the job's lease, reports progress and finishes the job.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from typing import Any

from fastapi import HTTPException
from fastapi_jobqueue import JobManager, Principal, Progress
from fastapi_jobqueue.errors import JobQueueError
from fastapi_jobqueue.models import JobError
from pydantic import JsonValue

from fastapi_app.lib.utils.logging_utils import get_logger

from .manager import get_job_manager

logger = get_logger(__name__)

PROGRESS_FIELDS = ("done", "total", "unit", "phase")


class RequestJobCancelled(Exception):
    """Raised in the request when the user cancelled its job."""


class RequestJob:
    """The client job that a request works on; see `run_request_job`."""

    def __init__(self, manager: JobManager, job_id: str, holder: str, principal: Principal, loop: asyncio.AbstractEventLoop):
        self.job_id = job_id
        self._manager = manager
        self._holder = holder
        self._principal = principal
        self._loop = loop
        self._cancelled = False
        self._progress: dict[str, Any] = {}
        self._message: str | None = None
        self._result: JsonValue = None
        self._pending: set[asyncio.Task[None]] = set()

    def check_cancelled(self) -> None:
        """Raise `RequestJobCancelled` if a cancel was requested. Safe to call from other threads."""
        if self._cancelled:
            raise RequestJobCancelled()

    def set_result(self, result: JsonValue) -> None:
        """Set the result that the job finishes with when the request ends normally."""
        self._result = result

    async def report(
        self,
        *,
        done: int | None = None,
        total: int | None = None,
        unit: str | None = None,
        phase: str | None = None,
        message: str | None = None,
    ) -> None:
        """
        Report progress; omitted fields keep their value. Also renews the lease.

        Raises:
            RequestJobCancelled: if a cancel was requested
        """
        self.check_cancelled()
        await self._write(dict(done=done, total=total, unit=unit, phase=phase, message=message))

    def report_threadsafe(
        self,
        *,
        done: int | None = None,
        total: int | None = None,
        unit: str | None = None,
        phase: str | None = None,
        message: str | None = None,
    ) -> None:
        """
        `report()` for code that runs in another thread (e.g. via `asyncio.to_thread`); the write
        happens on the event loop without waiting for it.

        Raises:
            RequestJobCancelled: if a cancel was requested
        """
        self.check_cancelled()
        fields = dict(done=done, total=total, unit=unit, phase=phase, message=message)
        self._loop.call_soon_threadsafe(self._schedule_write, fields)

    def _schedule_write(self, fields: dict[str, Any]) -> None:
        task = self._loop.create_task(self._write_logged(fields))
        self._pending.add(task)
        task.add_done_callback(self._pending.discard)

    async def _write_logged(self, fields: dict[str, Any]) -> None:
        try:
            await self._write(fields)
        except Exception as e:
            logger.warning(f"Could not report the progress of job {self.job_id}: {e}")

    async def _write(self, fields: dict[str, Any]) -> None:
        for key in PROGRESS_FIELDS:
            if fields.get(key) is not None:
                self._progress[key] = fields[key]
        if fields.get("message") is not None:
            self._message = fields["message"]
        done, total = self._progress.get("done"), self._progress.get("total")
        value = min(100, round(done * 100 / total)) if done is not None and total else None
        job = await self._manager.report(
            self.job_id, self._holder, progress=Progress(value=value, **self._progress), message=self._message, principal=self._principal
        )
        if job.cancel_requested:
            self._cancelled = True

    async def _drain(self) -> None:
        if self._pending:
            await asyncio.gather(*self._pending, return_exceptions=True)

    async def _heartbeats(self) -> None:
        """Renew the lease every third of its TTL and record whether a cancel was requested."""
        while True:
            await asyncio.sleep(self._manager.lease_ttl / 3)
            try:
                job = await self._manager.heartbeat(self.job_id, self._holder, self._principal)
            except JobQueueError as e:
                # Without the lease the job can no longer be reported or finished
                logger.warning(f"Job {self.job_id} lost its lease: {e.message}")
                self._cancelled = True
                return
            except Exception:
                logger.exception(f"Could not renew the lease of job {self.job_id}")
                continue
            if job.cancel_requested:
                self._cancelled = True

    async def _finish(self, **kwargs: Any) -> None:
        await self._drain()
        try:
            await self._manager.finish(self.job_id, self._holder, principal=self._principal, **kwargs)
        except Exception:
            logger.exception(f"Could not finish job {self.job_id}")


async def _claim(manager: JobManager, job_id: str, holder: str, principal: Principal) -> None:
    try:
        await manager.claim(job_id, holder, principal)
    except JobQueueError as e:
        raise HTTPException(status_code=e.status_code, detail=e.message) from e


@asynccontextmanager
async def run_request_job(job_id: str, principal: Principal) -> AsyncIterator[RequestJob]:
    """
    Run the body as the driver of a client job: claim it, keep its lease, and finish it when the body ends.

    The job ends `done` with the value of `RequestJob.set_result`; `cancelled` if the body raises
    `RequestJobCancelled`; `error` (with the `status_code` of the exception, or 500) for any other
    exception. Exceptions are re-raised.

    Args:
        job_id: Id of a client job of the principal
        principal: The owner of the job

    Raises:
        HTTPException: 404 if the job does not exist or is not visible, 409 if it cannot be claimed
    """
    manager = get_job_manager()
    holder = f"request:{uuid.uuid4()}"
    await _claim(manager, job_id, holder, principal)
    job = RequestJob(manager, job_id, holder, principal, asyncio.get_running_loop())
    heartbeats = asyncio.create_task(job._heartbeats(), name=f"request-job-{job_id}")
    try:
        yield job
        await job._finish(result=job._result)
    except RequestJobCancelled:
        await job._finish(cancelled=True)
        raise
    except Exception as e:
        await job._finish(error=JobError(message=str(e), status=getattr(e, "status_code", 500)))
        raise
    finally:
        heartbeats.cancel()
        await asyncio.gather(heartbeats, return_exceptions=True)
