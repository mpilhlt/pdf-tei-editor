"""
Remote Queue Manager for WebDAV synchronization.

Manages an append-only operation log (queue.db) on the WebDAV server.

Each sync client has a UUID and tracks the last operation sequence number it
has applied (last_applied_seq).  The log records every mutation (upsert /
delete) from every client; on sync a client applies all ops since its own
last_applied_seq that were produced by other clients, then appends its own
pending ops.  Because the log is append-only, an empty or missing queue.db
means "no ops yet" — it never destroys existing client state.
"""

import gc
import json
import os
import shutil
import sqlite3
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from webdav4.fsspec import WebdavFileSystem

QUEUE_SCHEMA = """
CREATE TABLE IF NOT EXISTS ops (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id  TEXT NOT NULL,
    op_type    TEXT NOT NULL,   -- 'upsert' | 'delete'
    stable_id  TEXT NOT NULL,
    file_id    TEXT NOT NULL,
    file_data  TEXT,            -- JSON metadata blob for upsert ops
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ops_seq ON ops(seq);
CREATE INDEX IF NOT EXISTS idx_ops_client ON ops(client_id);

CREATE TABLE IF NOT EXISTS clients (
    client_id        TEXT PRIMARY KEY,
    last_applied_seq INTEGER NOT NULL DEFAULT 0,
    last_seen_at     TEXT NOT NULL
);
"""


class RemoteQueueManager:
    """
    Manages the shared operation-log database (queue.db) on the WebDAV server.

    Thread-safety: not thread-safe.  Each sync cycle creates its own instance.
    """

    def __init__(self, webdav_config: Dict[str, str], logger=None):
        self.logger = logger
        self.remote_root = webdav_config["remote_root"].rstrip("/")
        self.remote_db_path = f"{self.remote_root}/queue.db"

        self.fs = WebdavFileSystem(
            webdav_config["base_url"],
            auth=(webdav_config["username"], webdav_config["password"]),
        )

        self._conn: Optional[sqlite3.Connection] = None
        self._temp_db_path: Optional[Path] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def download(self) -> Path:
        """
        Download queue.db from WebDAV to a temporary file.

        If the file does not yet exist on the remote, creates an empty database
        with the schema (no ops, no clients).  An empty log is safe: it means
        "no operations have been recorded yet".

        Returns:
            Path to the temporary database file.
        """
        temp_fd, temp_path = tempfile.mkstemp(suffix=".db", prefix="queue_")
        os.close(temp_fd)
        self._temp_db_path = Path(temp_path)

        if self.fs.exists(self.remote_db_path):
            if self.logger:
                self.logger.info(f"Downloading queue.db from {self.remote_db_path}")
            with self.fs.open(self.remote_db_path, "rb") as rf:
                with open(self._temp_db_path, "wb") as lf:
                    shutil.copyfileobj(rf, lf)
        else:
            if self.logger:
                self.logger.info("queue.db not found on remote — creating empty log")
            conn = sqlite3.connect(self._temp_db_path)
            try:
                conn.executescript(QUEUE_SCHEMA)
                conn.commit()
            finally:
                conn.close()

        return self._temp_db_path

    def connect(self, db_path: Path) -> None:
        """Open a connection to the downloaded database."""
        if self._conn:
            self._conn.close()
        self._conn = sqlite3.connect(db_path)
        self._conn.row_factory = sqlite3.Row
        # Ensure schema exists (handles stale DB without ops/clients tables)
        self._conn.executescript(QUEUE_SCHEMA)
        self._conn.commit()

    def disconnect(self) -> None:
        """Close connection and clean up temporary file."""
        if self._conn:
            self._conn.close()
            del self._conn
            self._conn = None

        gc.collect()

        if self._temp_db_path and self._temp_db_path.exists():
            for attempt in range(5):
                try:
                    self._temp_db_path.unlink()
                    self._temp_db_path = None
                    break
                except (PermissionError, OSError):
                    if attempt < 4:
                        time.sleep(0.1 * (attempt + 1))
                        gc.collect()
                    else:
                        self._temp_db_path = None

    def upload(self, local_path: Path) -> None:
        """Upload queue.db to the WebDAV server."""
        if not self.fs.exists(self.remote_root):
            self.fs.makedirs(self.remote_root)
        with open(local_path, "rb") as lf:
            with self.fs.open(self.remote_db_path, "wb") as rf:
                shutil.copyfileobj(lf, rf)
        if self.logger:
            self.logger.info("Uploaded queue.db")

    # ------------------------------------------------------------------
    # Client registry
    # ------------------------------------------------------------------

    def register_client(self, client_id: str) -> None:
        """Insert or refresh this client's entry in the clients table."""
        self._require_conn()
        now = datetime.now(timezone.utc).isoformat()
        self._conn.execute(  # type: ignore[union-attr]
            """
            INSERT INTO clients (client_id, last_applied_seq, last_seen_at)
            VALUES (?, 0, ?)
            ON CONFLICT(client_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
            """,
            (client_id, now),
        )
        self._conn.commit()  # type: ignore[union-attr]

    def update_client_seq(self, client_id: str, last_seq: int) -> None:
        """Record the highest seq this client has applied."""
        self._require_conn()
        now = datetime.now(timezone.utc).isoformat()
        self._conn.execute(  # type: ignore[union-attr]
            """
            INSERT INTO clients (client_id, last_applied_seq, last_seen_at)
            VALUES (?, ?, ?)
            ON CONFLICT(client_id) DO UPDATE SET
                last_applied_seq = excluded.last_applied_seq,
                last_seen_at     = excluded.last_seen_at
            """,
            (client_id, last_seq, now),
        )
        self._conn.commit()  # type: ignore[union-attr]

    def get_client_seq(self, client_id: str) -> int:
        """Return the last_applied_seq stored for this client in the DB (0 if unknown)."""
        self._require_conn()
        row = self._conn.execute(  # type: ignore[union-attr]
            "SELECT last_applied_seq FROM clients WHERE client_id = ?", (client_id,)
        ).fetchone()
        return int(row["last_applied_seq"]) if row else 0

    # ------------------------------------------------------------------
    # Operation log
    # ------------------------------------------------------------------

    def get_pending_ops(self, own_client_id: str, since_seq: int) -> List[Dict[str, Any]]:
        """
        Return ops produced by other clients with seq > since_seq, ordered by seq.

        Args:
            own_client_id: This instance's client ID (ops from self are skipped).
            since_seq: Only return ops with seq strictly greater than this value.

        Returns:
            List of op dicts with keys: seq, client_id, op_type, stable_id,
            file_id, file_data (str or None), created_at.
        """
        self._require_conn()
        rows = self._conn.execute(  # type: ignore[union-attr]
            """
            SELECT seq, client_id, op_type, stable_id, file_id, file_data, created_at
            FROM ops
            WHERE seq > ? AND client_id != ?
            ORDER BY seq ASC
            """,
            (since_seq, own_client_id),
        ).fetchall()
        return [dict(r) for r in rows]

    def append_ops(self, ops: List[Dict[str, Any]]) -> int:
        """
        Insert a list of ops into the log.

        Args:
            ops: List of dicts with keys: client_id, op_type, stable_id,
                 file_id, file_data (str or None), created_at.

        Returns:
            The seq of the last inserted op, or 0 if ops is empty.
        """
        if not ops:
            return self.get_max_seq()
        self._require_conn()
        last_id = 0
        with self._transaction():
            for op in ops:
                cur = self._conn.execute(  # type: ignore[union-attr]
                    """
                    INSERT INTO ops (client_id, op_type, stable_id, file_id, file_data, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        op["client_id"],
                        op["op_type"],
                        op["stable_id"],
                        op["file_id"],
                        op.get("file_data"),
                        op["created_at"],
                    ),
                )
                last_id = cur.lastrowid
        return last_id

    def get_max_seq(self) -> int:
        """Return the highest seq in the log, or 0 if the log is empty."""
        self._require_conn()
        row = self._conn.execute("SELECT MAX(seq) AS m FROM ops").fetchone()  # type: ignore[union-attr]
        return int(row["m"]) if row and row["m"] is not None else 0

    def compact(self, stale_after_days: int = 7) -> None:
        """
        Remove ops that all active clients have already applied, and purge
        clients that have been absent for more than stale_after_days days.

        Compaction is best-effort: if it fails the sync cycle still succeeds.
        """
        self._require_conn()
        try:
            cutoff = (
                datetime.now(timezone.utc) - timedelta(days=stale_after_days)
            ).isoformat()
            with self._transaction():
                # Drop stale clients first so their watermark doesn't block compaction.
                self._conn.execute(  # type: ignore[union-attr]
                    "DELETE FROM clients WHERE last_seen_at < ?", (cutoff,)
                )
                row = self._conn.execute(  # type: ignore[union-attr]
                    "SELECT MIN(last_applied_seq) AS m FROM clients"
                ).fetchone()
                min_seq = int(row["m"]) if row and row["m"] is not None else 0
                if min_seq > 0:
                    self._conn.execute(  # type: ignore[union-attr]
                        "DELETE FROM ops WHERE seq <= ?", (min_seq,)
                    )
        except Exception as exc:
            if self.logger:
                self.logger.warning(f"Compaction failed (non-fatal): {exc}")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _require_conn(self) -> None:
        if not self._conn:
            raise RuntimeError("Not connected to queue database")

    @contextmanager
    def _transaction(self):
        try:
            yield self._conn
            self._conn.commit()  # type: ignore[union-attr]
        except Exception:
            self._conn.rollback()  # type: ignore[union-attr]
            raise
