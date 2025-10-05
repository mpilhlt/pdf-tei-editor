"""
Server utility functions for PDF-TEI-Editor.

This module provides framework-agnostic server utilities with dependency injection.
Includes FastAPI-specific helpers for request handling.
"""

import re
from datetime import datetime
from pathlib import Path
from typing import Optional


class ApiError(RuntimeError):
    """
    Custom exception class for API-specific errors.

    Attributes:
        message -- explanation of the error
        status_code -- the HTTP (or other) status code associated with the error
    """
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.status_code = status_code


# Pure utility functions (no dependencies)


def make_timestamp() -> str:
    """
    Create a timestamp string in format "YYYY-MM-DD HH:MM:SS".

    Returns:
        Formatted timestamp string
    """
    now = datetime.now()
    return now.strftime("%Y-%m-%d %H:%M:%S")


def make_version_timestamp() -> str:
    """
    Create a timestamp formatted for version filenames (safe for filesystem).

    Format: YYYY-MM-DD_HH-MM-SS

    Returns:
        Filesystem-safe timestamp string
    """
    return make_timestamp().replace(" ", "_").replace(":", "-")


# Version timestamp format constants
VERSION_TIMESTAMP_REGEX = re.compile(r'^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-')


def strip_version_timestamp_prefix(filename: str) -> str:
    """
    Remove version timestamp prefix from filename if present.

    Args:
        filename: Filename that may have timestamp prefix

    Returns:
        Filename without timestamp prefix
    """
    return VERSION_TIMESTAMP_REGEX.sub('', filename)


def safe_file_path(file_path: str) -> str:
    """
    Sanitize file path for safe filesystem operations.

    Removes non-alphabetic leading characters, strips "/data" prefix,
    and replaces filesystem-incompatible characters with underscores.

    Args:
        file_path: File path to sanitize

    Returns:
        Sanitized file path

    Raises:
        ApiError: If file path is invalid or empty
    """
    if not file_path:
        raise ApiError("Invalid file path: path is empty", status_code=400)

    # Remove leading non-alphabetic characters
    while len(file_path) > 0 and not file_path[0].isalpha():
        file_path = file_path[1:]

    if not file_path.startswith("data/"):
        raise ApiError(f"Invalid file path: {file_path}", status_code=400)

    # Remove the 'data/' prefix
    cleaned_path = file_path.removeprefix('data/')

    # Split path into components, sanitize each component, then rejoin
    path_parts = cleaned_path.split('/')
    sanitized_parts = []

    for part in path_parts:
        if part:  # Skip empty parts
            # Replace characters incompatible with Windows/POSIX filesystems
            sanitized_part = ''
            for char in part:
                if char in '%<>:"|?*\\' or ord(char) < 32:
                    sanitized_part += '_'
                else:
                    sanitized_part += char
            sanitized_parts.append(sanitized_part)

    return '/'.join(sanitized_parts)


# Functions with dependency injection


def get_data_file_path(document_id: str, data_root: Path, file_type: str, version: str = None) -> Path:
    """
    Get the full path to a data file.

    Note: This is a legacy function. New code should use hash-based storage
    via hash_utils.get_storage_path().

    Args:
        document_id: Document identifier
        data_root: Root directory for data files
        file_type: Type of file (for extension determination)
        version: Optional version identifier

    Returns:
        Full path to the data file
    """
    # For now, simple path construction
    # Will be replaced with hash-based lookup in Phase 2
    safe_path = safe_file_path(f"data/{document_id}")
    return data_root / safe_path


def get_version_path(data_root: Path, file_hash: str, version: str) -> Path:
    """
    Get the path for a versioned file.

    Args:
        data_root: Root directory for data files
        file_hash: Hash of the file
        version: Version timestamp

    Returns:
        Path to the version file
    """
    return data_root / "versions" / file_hash / f"{version}-{file_hash}.tei.xml"


def resolve_document_identifier(doc_id: str, db_dir: Path, logger=None) -> str:
    """
    Resolve a document identifier that can be either a file path or a hash.

    This is a placeholder for Phase 2 when SQLite lookup will be implemented.

    Args:
        doc_id: Document identifier (path or hash)
        db_dir: Database directory
        logger: Optional logger

    Returns:
        Resolved file path

    Raises:
        ApiError: If identifier cannot be resolved
    """
    if not doc_id:
        raise ApiError("Document identifier is empty", status_code=400)

    # Direct path handling (test mode only)
    if doc_id.startswith('/data/'):
        import os
        if not os.environ.get('TEST_IN_PROGRESS'):
            raise ApiError("Direct file paths are only allowed in test mode", status_code=400)
        return doc_id

    # Hash lookup - placeholder for Phase 2 SQLite implementation
    # For now, treat as error
    raise ApiError(f"Hash lookup not yet implemented in Phase 1", status_code=501)


# FastAPI-specific helpers


try:
    from fastapi import Request

    def get_session_id_from_request(request: Request) -> Optional[str]:
        """
        Extract session ID from FastAPI request.

        Checks in order:
        1. Headers (X-Session-Id) - Primary method for per-tab sessions
        2. Query parameters (sessionId) - For EventSource/SSE connections
        3. Cookies (sessionId) - Fallback (note: shared across tabs)

        Args:
            request: FastAPI Request object

        Returns:
            Session ID if found, None otherwise
        """
        # 1. Try headers (primary method - supports per-tab sessions)
        session_id = request.headers.get('X-Session-Id')
        if session_id:
            return session_id

        # 2. Try query parameters (for EventSource/SSE)
        session_id = request.query_params.get('sessionId')
        if session_id:
            return session_id

        # 3. Fall back to cookies (shared across tabs)
        return request.cookies.get('sessionId')

except ImportError:
    # FastAPI not available, skip FastAPI-specific functions
    pass
