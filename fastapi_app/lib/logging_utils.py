"""
Logging utilities for FastAPI application.

Provides category-based logging filtering
"""

import logging
import sys
from typing import Optional


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
    if log_categories is None:
        log_categories = []

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(getattr(logging, log_level.upper()))

    # Remove existing handlers
    root_logger.handlers.clear()

    # Create console handler with formatter
    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(getattr(logging, log_level.upper()))

    # Format: timestamp - level - name - message
    formatter = logging.Formatter(
        fmt='%(asctime)s - %(levelname)s - %(name)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    handler.setFormatter(formatter)

    # Add category filter if specified
    if log_categories:
        handler.addFilter(CategoryFilter(log_categories))

    root_logger.addHandler(handler)


def get_logger(name: str) -> logging.Logger:
    """
    Get a logger instance for a specific module/category.

    Args:
        name: Logger name (typically __name__ of the module)

    Returns:
        Logger instance
    """
    return logging.getLogger(name)
