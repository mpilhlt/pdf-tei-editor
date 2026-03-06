"""
Logging utilities for FastAPI application.

Provides category-based logging filtering and SSE log handler management.
"""

import logging
import sys
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from fastapi_app.lib.sse.sse_log_handler import SSELogHandler
    from fastapi_app.lib.sse.sse_service import SSEService

_sse_log_handler: Optional["SSELogHandler"] = None


class _SuppressWindowsConnectionReset(logging.Filter):
    """Suppress benign WinError 10054 noise from asyncio on Windows.

    When Playwright (or any HTTP client) hard-closes a connection with a TCP
    RST, Python's ProactorEventLoop logs a spurious ERROR from
    _call_connection_lost. The error is harmless but pollutes the log file.
    This filter drops those records without affecting any other asyncio logs.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        return '_call_connection_lost' not in record.getMessage()


class CategoryFilter(logging.Filter):
    """Filter log records by category prefix"""

    def __init__(self, categories: list[str]):
        super().__init__()
        self.categories = categories

    def filter(self, record: logging.LogRecord) -> bool:
        # If no categories specified, allow all
        if not self.categories:
            return True

        # Check if logger name starts with any allowed category
        return any(record.name.startswith(cat) for cat in self.categories)


def setup_logging(log_level: str = "INFO", log_categories: Optional[list[str]] = None):
    """
    Configure logging for the application.

    Args:
        log_level: Log level (DEBUG, INFO, WARNING, ERROR, CRITICAL)
        log_categories: List of category prefixes to log (empty = all)
    """
    from pathlib import Path

    if log_categories is None:
        log_categories = []

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(getattr(logging, log_level.upper()))

    # Remove existing handlers
    root_logger.handlers.clear()

    # Format: timestamp [level] name - message
    formatter = logging.Formatter(
        fmt='%(asctime)s.%(msecs)03d [%(levelname)-8s] %(name)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )

    # Create console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(getattr(logging, log_level.upper()))
    console_handler.setFormatter(formatter)

    # Add category filter if specified
    if log_categories:
        console_handler.addFilter(CategoryFilter(log_categories))

    root_logger.addHandler(console_handler)

    # Create file handler for application logs
    from fastapi_app.config import get_settings
    settings = get_settings()
    log_file = settings.app_log_file
    log_file.parent.mkdir(parents=True, exist_ok=True)

    file_handler = logging.FileHandler(log_file, encoding='utf-8')
    file_handler.setLevel(getattr(logging, log_level.upper()))
    file_handler.setFormatter(formatter)

    if log_categories:
        file_handler.addFilter(CategoryFilter(log_categories))

    root_logger.addHandler(file_handler)

    # Suppress benign WinError 10054 noise from asyncio's ProactorEventLoop.
    if sys.platform == 'win32':
        logging.getLogger('asyncio').addFilter(_SuppressWindowsConnectionReset())

    # Reconfigure uvicorn loggers to use the same format.
    # This ensures consistency even when uvicorn is started without --log-config
    # (e.g., in tests or programmatic usage).
    for uvicorn_logger_name in ['uvicorn', 'uvicorn.error', 'uvicorn.access']:
        uvicorn_logger = logging.getLogger(uvicorn_logger_name)
        for handler in uvicorn_logger.handlers:
            handler.setFormatter(formatter)


def get_logger(name: str) -> logging.Logger:
    """
    Get a logger instance for a specific module/category.

    Args:
        name: Logger name (typically __name__ of the module)

    Returns:
        Logger instance
    """
    return logging.getLogger(name)


def install_sse_log_handler(sse_service: "SSEService") -> "SSELogHandler":
    """
    Install SSE log handler on the root logger.

    Called once during application startup (lifespan).

    Args:
        sse_service: SSEService singleton instance

    Returns:
        The installed SSELogHandler instance
    """
    global _sse_log_handler
    if _sse_log_handler is not None:
        return _sse_log_handler

    from fastapi_app.lib.sse.sse_log_handler import SSELogHandler

    handler = SSELogHandler(sse_service)
    logging.getLogger().addHandler(handler)
    _sse_log_handler = handler
    return handler


def get_sse_log_handler() -> Optional["SSELogHandler"]:
    """Get the installed SSE log handler, or None if not installed."""
    return _sse_log_handler
