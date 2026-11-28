"""Adapters between the job API and code that reports progress through plain callbacks."""

from __future__ import annotations

from collections.abc import Callable

from fastapi_jobqueue.errors import JobCancelled

from .request_job import RequestJobCancelled


def thread_callbacks(
    report: Callable[..., None], check_cancelled: Callable[[], None]
) -> tuple[Callable[[int, int, str], None], Callable[[], bool]]:
    """
    Adapt a job's thread-safe reporting to the callbacks of code that runs in a thread.

    Args:
        report: `ctx.report_threadsafe` or `RequestJob.report_threadsafe`
        check_cancelled: `ctx.check_cancelled` or `RequestJob.check_cancelled`

    Returns:
        A `progress_callback(current, total, label)` that reports `done`, `total` and `phase`
        (it raises when the job was cancelled), and a `cancellation_check() -> bool` that returns
        True instead of raising.
    """
    def progress_callback(current: int, total: int, label: str) -> None:
        report(done=current, total=total, phase=label)

    def cancellation_check() -> bool:
        try:
            check_cancelled()
        except (JobCancelled, RequestJobCancelled):
            return True
        return False

    return progress_callback, cancellation_check
