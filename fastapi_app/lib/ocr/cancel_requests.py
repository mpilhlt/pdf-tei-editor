"""
Cancel requests for running HTTP requests that report their steps to a progress widget of the
client, such as writing text corrections into a PDF.

A request is named by the session that sent it and the id of its progress widget. The requests
are stored as marker files, so that a request run by one worker process can be cancelled through
another one.
"""

import hashlib
from pathlib import Path


class CancelRequests:
    """Records and reads cancel requests as marker files in a directory."""

    def __init__(self, directory: Path):
        self.directory = directory

    def _path(self, session_id: str, request_id: str) -> Path:
        # the session id must not appear in file names
        key = hashlib.sha256(f"{session_id}\0{request_id}".encode("utf-8")).hexdigest()
        return self.directory / f"{key}.cancel"

    def request(self, session_id: str, request_id: str) -> None:
        """Ask the request to stop at its next check."""
        self.directory.mkdir(parents=True, exist_ok=True)
        self._path(session_id, request_id).touch()

    def is_requested(self, session_id: str, request_id: str) -> bool:
        """Return whether the request was asked to stop."""
        return self._path(session_id, request_id).exists()

    def clear(self, session_id: str, request_id: str) -> None:
        """Forget a cancel request, when its request starts or ends."""
        self._path(session_id, request_id).unlink(missing_ok=True)
