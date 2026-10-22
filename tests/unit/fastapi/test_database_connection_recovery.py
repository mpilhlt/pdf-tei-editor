"""
Unit tests for DatabaseManager recovery from SQLite "disk I/O error" (issue #589).

When the -wal file of a WAL-mode database is removed while connections are open,
every new connection of the process fails with "disk I/O error" as long as any
connection to the database stays open. DatabaseManager pools its connections, so
without recovery the error persisted until the server was restarted.

@testCovers fastapi_app/lib/core/database.py
"""

import gc
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.core.database import DatabaseManager, is_connection_broken


class TestIsConnectionBroken(unittest.TestCase):
    """Test the classification of SQLite errors."""

    def test_io_error_is_broken(self):
        error = sqlite3.OperationalError("disk I/O error")
        error.sqlite_errorcode = sqlite3.SQLITE_IOERR_SHORT_READ
        self.assertTrue(is_connection_broken(error))

    def test_corrupt_error_is_broken(self):
        error = sqlite3.DatabaseError("database disk image is malformed")
        error.sqlite_errorcode = sqlite3.SQLITE_CORRUPT
        self.assertTrue(is_connection_broken(error))

    def test_busy_error_is_not_broken(self):
        error = sqlite3.OperationalError("database is locked")
        error.sqlite_errorcode = sqlite3.SQLITE_BUSY
        self.assertFalse(is_connection_broken(error))

    def test_other_exceptions_are_not_broken(self):
        self.assertFalse(is_connection_broken(ValueError("disk I/O error")))


class TestConnectionRecovery(unittest.TestCase):
    """Test that the connection pool recovers after the WAL file was removed."""

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp())
        self.db_path = self.test_dir / "metadata.db"
        self.db = DatabaseManager(self.db_path)
        self.wal_path = Path(f"{self.db_path}-wal")

    def tearDown(self):
        gc.collect()
        shutil.rmtree(self.test_dir)

    def _insert(self, stable_id: str) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO files (id, stable_id, filename, doc_id, file_type) VALUES (?, ?, ?, ?, ?)",
                (f"hash-{stable_id}", stable_id, f"{stable_id}.pdf", "10.1234/test", "pdf")
            )

    def _count(self) -> int:
        with self.db.get_connection() as conn:
            return conn.execute("SELECT COUNT(*) FROM files").fetchone()[0]

    def _remove_wal(self) -> None:
        self.assertTrue(self.wal_path.exists(), "test requires the WAL file to exist")
        self.wal_path.unlink()

    def _query_with_new_connection(self) -> None:
        """Run a query on a new connection while the pooled connection is in use."""
        with self.db.get_connection() as held:
            held.execute("SELECT 1").fetchone()
            with self.db.get_connection() as conn:
                conn.execute("SELECT COUNT(*) FROM files").fetchone()

    def test_recovers_after_wal_file_removed(self):
        self._insert("abc123")  # leaves one idle connection in the pool
        self._remove_wal()

        # A new connection fails: the pooled connection keeps the WAL index of the removed file mapped
        with self.assertLogs("fastapi_app.lib.core.database", level="WARNING") as logs:
            with self.assertRaises(sqlite3.DatabaseError) as ctx:
                self._query_with_new_connection()
        self.assertTrue(is_connection_broken(ctx.exception))
        self.assertIn("metadata.db-wal: ", logs.output[0])

        # All connections were closed, so the next ones work again
        self._insert("def456")
        self.assertGreaterEqual(self._count(), 1)
        self._query_with_new_connection()

    def test_error_persists_without_reset(self):
        """Documents the SQLite behaviour that the recovery handles."""
        self._insert("abc123")
        held = sqlite3.connect(str(self.db_path))
        try:
            held.execute("SELECT 1").fetchone()
            self._remove_wal()
            for _ in range(3):
                fresh = sqlite3.connect(str(self.db_path))
                try:
                    with self.assertRaises(sqlite3.OperationalError):
                        fresh.execute("SELECT COUNT(*) FROM files").fetchone()
                finally:
                    fresh.close()
        finally:
            held.close()


if __name__ == "__main__":
    unittest.main()
