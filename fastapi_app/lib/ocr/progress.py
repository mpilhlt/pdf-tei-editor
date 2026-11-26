"""
Progress reports of OCR runs.

An engine calls `report_progress()` while `OcrEngine.recognize()` runs. The caller of
`recognize()` receives the reports by running it inside `progress_reporter()`. The reporter is
kept in a context variable, which `asyncio.to_thread()` passes on to the worker thread, so the
signature of `recognize()` does not change and engines that do not report progress need no
change. Reports from other threads than the one running `recognize()` are not received.

A run is cancelled through its progress reports: if the caller passes `is_cancelled` to
`progress_reporter()` and it returns True, the next report raises `OcrCancelled`, which stops the
engine at the point where it reports. Engines that do not report progress run to the end; the
caller checks `is_cancelled` again afterwards.
"""

import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Optional

from fastapi_app.lib.models.models_ocr import OcrProgress

ProgressCallback = Callable[[OcrProgress], None]



class OcrCancelled(BaseException):
    """
    The user cancelled the OCR run.

    A BaseException like `asyncio.CancelledError`, so that the `except Exception` handlers that
    keep a run going despite errors (e.g. of the LLM correction pass) do not catch it.
    """


_reporter: ContextVar[Optional["ProgressTracker"]] = ContextVar("ocr_progress_reporter", default=None)


class ProgressTracker:
    """Turns progress reports into `OcrProgress` with an estimate of the remaining time."""

    def __init__(self, callback: ProgressCallback, clock: Callable[[], float] = time.monotonic, is_cancelled: Optional[Callable[[], bool]] = None):
        self._callback = callback
        self._clock = clock
        self._is_cancelled = is_cancelled
        self._phase = ""
        self._phase_started = 0.0

    def report(self, phase: str, done: Optional[int] = None, total: Optional[int] = None, unit: Optional[str] = None) -> None:
        """
        Report the current phase of the run and, if known, how much of it is done.

        The remaining time of a phase is extrapolated from the time it took to do the units
        done so far.

        Raises:
            OcrCancelled: if the run was cancelled
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
        self._callback(OcrProgress(phase=phase, done=done, total=total, unit=unit, eta_seconds=eta))

    def check_cancelled(self) -> None:
        """
        Raises:
            OcrCancelled: if the run was cancelled
        """
        if self._is_cancelled is not None and self._is_cancelled():
            raise OcrCancelled()


@contextmanager
def progress_reporter(callback: ProgressCallback, is_cancelled: Optional[Callable[[], bool]] = None) -> Iterator[ProgressTracker]:
    """
    Receive the progress reports of code run inside this context.

    Args:
        callback: Receives the reports
        is_cancelled: Returns whether the run was cancelled; then the next report raises `OcrCancelled`
    """
    tracker = ProgressTracker(callback, is_cancelled=is_cancelled)
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
        OcrCancelled: if the run was cancelled
    """
    tracker = _reporter.get()
    if tracker is not None:
        tracker.report(phase, done, total, unit)
