"""
Detailed log of the last OCR run, kept apart from the application log.

OCRmyPDF and the footnote marker repair log every step, subprocess and repaired word. That
detail is only needed to investigate a particular run, so during a run it is written to a file
of its own (`ocr-last-run.log` in the log directory), which the next run overwrites. Only
warnings and errors of these loggers reach the application log; the engine itself logs a short
summary of the run there.
"""

import logging
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

RUN_LOG_NAME = "ocr-last-run.log"

DETAIL_LOGGERS = (
    "ocrmypdf",
    # Libraries OCRmyPDF uses to build the PDF
    "img2pdf",
    "fpdf",
    "fontTools",
    "fastapi_app.plugins.ocrmypdf.footnote_markers",
    "fastapi_app.plugins.ocrmypdf.ocrmypdf_plugin",
    "fastapi_app.plugins.ocrmypdf.vectorize",
)
"""Loggers whose records go only to the run log, except warnings and errors."""

SUMMARY_LOGGERS = ("fastapi_app.plugins.ocrmypdf.engine",)
"""Loggers whose records go to the run log and, as usual, to the application log."""

_lock = threading.Lock()
_active = 0
_saved: dict[str, tuple[int, bool]] = {}
_handlers: list[logging.Handler] = []
_path: Path | None = None


class _ForwardHandler(logging.Handler):
    """Passes records on to the handlers of the root logger, i.e. the application log."""

    def emit(self, record: logging.LogRecord) -> None:
        logging.getLogger().handle(record)


def run_log_path(log_dir: Path) -> Path:
    """Return the path of the run log in a log directory."""
    return log_dir / RUN_LOG_NAME


@contextmanager
def ocr_run_log(path: Path | None) -> Iterator[Path | None]:
    """
    Write the detailed log of an OCR run to `path` instead of the application log.

    The file is overwritten. The server runs one OCR job at a time; if runs overlap anyway
    (e.g. in tests), they share the file of the first run.

    Args:
        path: The run log file, None to only keep the detail out of the application log

    Yields:
        The path of the run log, or None if it could not be opened
    """
    global _active
    with _lock:
        if _active == 0:
            _install(path)
        _active += 1
        current = _path
    try:
        yield current
    finally:
        with _lock:
            _active -= 1
            if _active == 0:
                _uninstall()


def _install(path: Path | None) -> None:
    global _path
    file_handler: logging.Handler | None = None
    if path is not None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            file_handler = logging.FileHandler(path, mode="w", encoding="utf-8")
            file_handler.setLevel(logging.DEBUG)
            file_handler.setFormatter(logging.Formatter(fmt="%(asctime)s.%(msecs)03d [%(levelname)-8s] %(name)s - %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
        except OSError:
            logging.getLogger(__name__).warning(f"Could not open the OCR run log {path}", exc_info=True)
            file_handler = None
    forward = _ForwardHandler(logging.WARNING)
    if file_handler is not None:
        _handlers.append(file_handler)
        _path = path
    _handlers.append(forward)
    for name in DETAIL_LOGGERS:
        logger = logging.getLogger(name)
        _saved[name] = (logger.level, logger.propagate)
        logger.setLevel(logging.DEBUG if file_handler is not None else logging.WARNING)
        logger.propagate = False
        if file_handler is not None:
            logger.addHandler(file_handler)
        logger.addHandler(forward)
    for name in SUMMARY_LOGGERS:
        logger = logging.getLogger(name)
        _saved[name] = (logger.level, logger.propagate)
        if file_handler is not None:
            logger.addHandler(file_handler)


def _uninstall() -> None:
    global _path
    for name, (level, propagate) in _saved.items():
        logger = logging.getLogger(name)
        logger.setLevel(level)
        logger.propagate = propagate
        for handler in _handlers:
            logger.removeHandler(handler)
    for handler in _handlers:
        handler.close()
    _saved.clear()
    _handlers.clear()
    _path = None
