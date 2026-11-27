"""
Jobs that are driven by the request that does their work.

A route that needs the user's session (e.g. OCR text corrections) cannot run as a server job.
The client submits a client job, passes its id to the route, and the route runs inside
`run_request_job`, which holds the job's lease, reports progress and finishes the job.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import TypedDict

from fastapi import HTTPException
from fastapi_jobqueue import JobManager, Principal, Progress
from fastapi_jobqueue.errors import JobQueueError
from fastapi_jobqueue.models import JobError
from pydantic import JsonValue

from fastapi_app.lib.core.request_cancellation import SHUTDOWN_DETAIL
from fastapi_app.lib.utils.logging_utils import get_logger

from .manager import get_job_manager

logger = get_logger(__name__)


class RequestJobCancelled(Exception):
    """Raised in the request when the user cancelled its job."""


class ProgressFields(TypedDict, total=False):
    """The progress fields of a job that `RequestJob` keeps."""

    done: int
    total: int
    unit: str
    phase: str


class RequestJob:
    """The client job that a request works on; see `run_request_job`."""

    def __init__(self, manager: JobManager, job_id: str, holder: str, principal: Principal, loop: asyncio.AbstractEventLoop):
        self.job_id = job_id
        self._manager = manager
        self._holder = holder
        self._principal = principal
        self._loop = loop
        self._cancelled = False
        self._progress: ProgressFields = {}
        self._message: str | None = None
        self._result: JsonValue = None
        self._heartbeats_task: asyncio.Task[None] | None = None
        # Progress writes: always the latest state, one at a time, at most one per report_interval
        self._dirty = False
        self._urgent = False
        self._last_write = 0.0
        self._write_lock = asyncio.Lock()
        self._delayed_flush: asyncio.Task[None] | None = None

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
        Report progress; omitted fields keep their value. Writes are coalesced to one per
        `report_interval` of the manager; a new phase or message is written at once.

        Raises:
            RequestJobCancelled: if a cancel was requested
        """
        self.check_cancelled()
        self._apply(done, total, unit, phase, message)
        await self._flush_if_due()

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
        self._loop.call_soon_threadsafe(self._apply_and_schedule, done, total, unit, phase, message)

    def _apply(self, done: int | None, total: int | None, unit: str | None, phase: str | None, message: str | None) -> None:
        if done is not None:
            self._progress["done"] = done
        if total is not None:
            self._progress["total"] = total
        if unit is not None:
            self._progress["unit"] = unit
        if phase is not None:
            if phase != self._progress.get("phase"):
                self._urgent = True
            self._progress["phase"] = phase
        if message is not None:
            if message != self._message:
                self._urgent = True
            self._message = message
        self._dirty = True

    def _apply_and_schedule(self, done: int | None, total: int | None, unit: str | None, phase: str | None, message: str | None) -> None:
        self._apply(done, total, unit, phase, message)
        self._schedule_flush()

    def _due_in(self) -> float:
        """Seconds until a write may happen; 0 if one is due."""
        if self._urgent:
            return 0.0
        return max(0.0, self._last_write + self._manager.report_interval - self._manager.clock())

    def _schedule_flush(self) -> None:
        if self._delayed_flush is None or self._delayed_flush.done():
            self._delayed_flush = self._loop.create_task(self._delayed())

    async def _delayed(self) -> None:
        # Loops so that a state that changed during a wait or a write is written as well
        while self._dirty:
            await asyncio.sleep(self._due_in())
            try:
                await self._flush()
            except Exception as e:
                logger.warning(f"Could not report the progress of job {self.job_id}: {e}")
                return

    async def _flush_if_due(self) -> None:
        if not self._dirty:
            return
        if self._due_in() == 0:
            await self._flush()
        else:
            self._schedule_flush()

    async def _flush(self) -> None:
        """Write the latest state if it changed."""
        async with self._write_lock:
            if not self._dirty:
                return
            self._dirty = False
            self._urgent = False
            self._last_write = self._manager.clock()
            done, total = self._progress.get("done"), self._progress.get("total")
            value = min(100, round(done * 100 / total)) if done is not None and total else None
            job = await self._manager.report(
                self.job_id, self._holder, progress=Progress(value=value, **self._progress), message=self._message, principal=self._principal
            )
            if job.cancel_requested:
                self._cancelled = True

    async def _drain(self) -> None:
        """Write what is still pending."""
        if self._delayed_flush is not None:
            self._delayed_flush.cancel()
            await asyncio.gather(self._delayed_flush, return_exceptions=True)
        try:
            await self._flush()
        except Exception as e:
            logger.warning(f"Could not report the progress of job {self.job_id}: {e}")

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

    async def _stop_heartbeats(self) -> None:
        if self._heartbeats_task is not None:
            self._heartbeats_task.cancel()
            await asyncio.gather(self._heartbeats_task, return_exceptions=True)

    async def _finish(self, *, result: JsonValue = None, error: JobError | None = None, cancelled: bool = False) -> None:
        await self._stop_heartbeats()
        await self._drain()
        try:
            await self._manager.finish(self.job_id, self._holder, result=result, error=error, cancelled=cancelled, principal=self._principal)
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
    job._heartbeats_task = asyncio.create_task(job._heartbeats(), name=f"request-job-{job_id}")
    try:
        yield job
        await job._finish(result=job._result)
    except RequestJobCancelled:
        await job._finish(cancelled=True)
        raise
    except Exception as e:
        await job._finish(error=JobError(message=str(e), status=getattr(e, "status_code", 500)))
        raise
    except BaseException:
        # The request task was cancelled (server shutdown); a second cancellation must not interrupt the finish
        await asyncio.shield(job._finish(error=JobError(message=SHUTDOWN_DETAIL, status=503)))
        raise
    finally:
        await job._stop_heartbeats()
