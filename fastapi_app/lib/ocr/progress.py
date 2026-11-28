"""
Progress reports of OCR runs.

An engine calls `report_progress()` while `OcrEngine.recognize()` runs. The caller of
`recognize()` receives the reports by running it inside `progress_reporter()`. The reporter is
kept in a context variable, which `asyncio.to_thread()` passes on to the worker thread, so the
signature of `recognize()` does not change and engines that do not report progress need no
change. Reports from other threads than the one running `recognize()` are not received.

The OCR jobs (`fastapi_app/lib/ocr/job_types.py`) pass the job's `ctx.report_threadsafe` and
`ctx.check_cancelled`. A run is cancelled through its progress reports: once the job is
cancelled, the next report raises `JobCancelled`, which stops the engine at the point where it
reports. Engines that do not report progress run to the end; the caller checks for a cancel again
afterwards.
"""

import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Optional, Protocol


class ProgressReport(Protocol):
    """Receives a progress report; the signature of `JobContext.report_threadsafe`."""

    def __call__(self, *, phase: str, done: Optional[int], total: Optional[int], unit: Optional[str], eta_seconds: Optional[int]) -> None: ...


CancelCheck = Callable[[], None]
"""Raises (e.g. `JobCancelled`) if the run was cancelled; `JobContext.check_cancelled`."""


_reporter: ContextVar[Optional["ProgressTracker"]] = ContextVar("ocr_progress_reporter", default=None)


class ProgressTracker:
    """Passes progress reports on with an estimate of the remaining time."""

    def __init__(self, report: ProgressReport, clock: Callable[[], float] = time.monotonic, check_cancelled: Optional[CancelCheck] = None):
        self._report = report
        self._clock = clock
        self._check_cancelled = check_cancelled
        self._phase = ""
        self._phase_started = 0.0

    def report(self, phase: str, done: Optional[int] = None, total: Optional[int] = None, unit: Optional[str] = None) -> None:
        """
        Report the current phase of the run and, if known, how much of it is done.

        The remaining time of a phase is extrapolated from the time it took to do the units
        done so far.

        Raises:
            JobCancelled: (from `check_cancelled`) if the run was cancelled
        """
        self.check_cancelled()
        now = self._clock()
        if phase != self._phase:
            self._phase, self._phase_started = phase, now
        eta: Optional[int] = None
        if done and total and total > done:
            eta = round((now - self._phase_started) / done * (total - done))
        elif done and total:
            eta = 0
        self._report(phase=phase, done=done, total=total, unit=unit, eta_seconds=eta)

    def check_cancelled(self) -> None:
        """
        Raises:
            JobCancelled: (from `check_cancelled`) if the run was cancelled
        """
        if self._check_cancelled is not None:
            self._check_cancelled()


@contextmanager
def progress_reporter(report: ProgressReport, check_cancelled: Optional[CancelCheck] = None) -> Iterator[ProgressTracker]:
    """
    Receive the progress reports of code run inside this context.

    Args:
        report: Receives the reports, e.g. `ctx.report_threadsafe` of a job
        check_cancelled: Raises if the run was cancelled, e.g. `ctx.check_cancelled`; it is called
            before each report
    """
    tracker = ProgressTracker(report, check_cancelled=check_cancelled)
    token = _reporter.set(tracker)
    try:
        yield tracker
    finally:
        _reporter.reset(token)


def report_progress(phase: str, done: Optional[int] = None, total: Optional[int] = None, unit: Optional[str] = None) -> None:
    """
    Report the progress of an OCR run, if the caller receives progress reports.

    Args:
        phase: What the engine is doing, for the user (e.g. "Recognizing text")
        done: Units of the phase done so far, if the phase is counted
        total: Units of the phase in total
        unit: The unit, e.g. "page"

    Raises:
        JobCancelled: if the run was cancelled
    """
    tracker = _reporter.get()
    if tracker is not None:
        tracker.report(phase, done, total, unit)
