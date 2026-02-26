"""
Unit tests for garbage collection functionality.

Tests:
- Repository methods for querying deleted files
- Timestamp filtering
- sync_status filtering
- Additive filter behavior
- Permanent file deletion

@testCovers fastapi_app/lib/repository/file_repository.py::get_deleted_files_for_gc
@testCovers fastapi_app/lib/repository/file_repository.py::permanently_delete_file
"""

import unittest
import tempfile
import shutil
from pathlib import Path
from datetime import datetime, timedelta

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.storage.file_storage import FileStorage
from fastapi_app.lib.models.models import FileCreate


class TestGarbageCollection(unittest.TestCase):
    """Test garbage collection functionality."""

    def setUp(self):
        """Create temporary directories and initialize components."""
        self.test_dir = Path(tempfile.mkdtemp())
        self.db_path = self.test_dir / "test.db"
        self.storage_root = self.test_dir / "storage"

        self.storage_root.mkdir()

        # Initialize database and components
        self.db = DatabaseManager(self.db_path)
        self.repo = FileRepository(self.db)
        self.storage = FileStorage(self.storage_root, self.db)

    def tearDown(self):
        """Clean up temporary directories."""
        import gc
        gc.collect()
        shutil.rmtree(self.test_dir)

    def create_test_file(
        self,
        file_hash: str,
        doc_id: str = "test-doc",
        file_type: str = "tei",
        deleted: bool = False,
        sync_status: str = "modified"
    ):
        """Create a test file in the repository."""
        file_data = FileCreate(
            id=file_hash,
            filename=f"test-{file_hash[:8]}.{file_type}",
            doc_id=doc_id,
            file_type=file_type,
            file_size=1024,
            label=f"Test {file_type}",
        )

        # Insert file
        file_metadata = self.repo.insert_file(file_data)

        # Soft delete if requested
        if deleted:
            self.repo.delete_file(file_hash)

            # Update sync_status if not default
            if sync_status != "pending_delete":
                with self.db.transaction() as conn:
                    conn.execute(
                        "UPDATE files SET sync_status = ? WHERE id = ?",
                        (sync_status, file_hash)
                    )

        return file_metadata

    def test_get_deleted_files_for_gc_with_timestamp(self):
        """Test querying deleted files by timestamp."""
        # Create three files with different timestamps
        now = datetime.now()
        old_time = now - timedelta(days=10)
        recent_time = now - timedelta(days=1)

        # Create files
        old_file = self.create_test_file("a" * 64, deleted=True)
        recent_file = self.create_test_file("b" * 64, deleted=True)

        # Manually set updated_at times
        with self.db.transaction() as conn:
            conn.execute(
                "UPDATE files SET updated_at = ? WHERE id = ?",
                (old_time.isoformat(), old_file.id)
            )
            conn.execute(
                "UPDATE files SET updated_at = ? WHERE id = ?",
                (recent_time.isoformat(), recent_file.id)
            )

        # Query for files older than 5 days
        cutoff = now - timedelta(days=5)
        deleted_files = self.repo.get_deleted_files_for_gc(deleted_before=cutoff)

        # Should only get the old file
        self.assertEqual(len(deleted_files), 1)
        self.assertEqual(deleted_files[0].id, old_file.id)

    def test_get_deleted_files_for_gc_with_sync_status(self):
        """Test filtering by sync_status."""
        # Create files with different sync statuses
        pending_delete = self.create_test_file("a" * 64, deleted=True, sync_status="pending_delete")
        deletion_synced = self.create_test_file("b" * 64, deleted=True, sync_status="deletion_synced")
        error_status = self.create_test_file("c" * 64, deleted=True, sync_status="error")

        # Query for pending_delete only
        cutoff = datetime.now() + timedelta(days=1)  # Future time to get all
        deleted_files = self.repo.get_deleted_files_for_gc(
            deleted_before=cutoff,
            sync_status="pending_delete"
        )

        self.assertEqual(len(deleted_files), 1)
        self.assertEqual(deleted_files[0].id, pending_delete.id)

    def test_get_deleted_files_for_gc_additive_filters(self):
        """Test that filters are additive (all conditions must match)."""
        now = datetime.now()
        old_time = now - timedelta(days=10)

        # Create files with different combinations
        # Old + pending_delete
        old_pending = self.create_test_file("a" * 64, deleted=True, sync_status="pending_delete")
        # Old + deletion_synced
        old_synced = self.create_test_file("b" * 64, deleted=True, sync_status="deletion_synced")
        # Recent + pending_delete
        recent_pending = self.create_test_file("c" * 64, deleted=True, sync_status="pending_delete")

        # Set timestamps
        with self.db.transaction() as conn:
            conn.execute(
                "UPDATE files SET updated_at = ? WHERE id = ?",
                (old_time.isoformat(), old_pending.id)
            )
            conn.execute(
                "UPDATE files SET updated_at = ? WHERE id = ?",
                (old_time.isoformat(), old_synced.id)
            )

        # Query for old + pending_delete
        cutoff = now - timedelta(days=5)
        deleted_files = self.repo.get_deleted_files_for_gc(
            deleted_before=cutoff,
            sync_status="pending_delete"
        )

        # Should only get old_pending (both conditions match)
        self.assertEqual(len(deleted_files), 1)
        self.assertEqual(deleted_files[0].id, old_pending.id)

    def test_get_deleted_files_for_gc_excludes_active_files(self):
        """Test that non-deleted files are never returned."""
        now = datetime.now()
        old_time = now - timedelta(days=10)

        # Create active and deleted files
        active_file = self.create_test_file("a" * 64, deleted=False)
        deleted_file = self.create_test_file("b" * 64, deleted=True)

        # Set both to old timestamp
        with self.db.transaction() as conn:
            conn.execute(
                "UPDATE files SET updated_at = ? WHERE id IN (?, ?)",
                (old_time.isoformat(), active_file.id, deleted_file.id)
            )

        # Query for all old files
        cutoff = now - timedelta(days=5)
        deleted_files = self.repo.get_deleted_files_for_gc(deleted_before=cutoff)

        # Should only get deleted file
        self.assertEqual(len(deleted_files), 1)
        self.assertEqual(deleted_files[0].id, deleted_file.id)

    def test_permanently_delete_file(self):
        """Test permanent deletion of file records."""
        # Create and soft delete a file
        file_metadata = self.create_test_file("a" * 64, deleted=True)

        # Verify it exists as deleted
        deleted_file = self.repo.get_file_by_id(file_metadata.id, include_deleted=True)
        self.assertIsNotNone(deleted_file)
        self.assertTrue(deleted_file.deleted)

        # Permanently delete
        self.repo.permanently_delete_file(file_metadata.id)

        # Verify it's completely gone
        gone_file = self.repo.get_file_by_id(file_metadata.id, include_deleted=True)
        self.assertIsNone(gone_file)

    def test_permanently_delete_nonexistent_file(self):
        """Test that permanently deleting a nonexistent file raises ValueError."""
        with self.assertRaises(ValueError):
            self.repo.permanently_delete_file("nonexistent" * 8)

    def test_get_deleted_files_for_gc_empty_result(self):
        """Test that querying with no matches returns empty list."""
        # Create only active files
        self.create_test_file("a" * 64, deleted=False)
        self.create_test_file("b" * 64, deleted=False)

        # Query for deleted files
        cutoff = datetime.now() + timedelta(days=1)
        deleted_files = self.repo.get_deleted_files_for_gc(deleted_before=cutoff)

        self.assertEqual(len(deleted_files), 0)

    def test_sync_status_filter_none_value(self):
        """Test that sync_status=None includes all sync statuses."""
        # Create files with different sync statuses
        pending = self.create_test_file("a" * 64, deleted=True, sync_status="pending_delete")
        synced = self.create_test_file("b" * 64, deleted=True, sync_status="deletion_synced")

        # Query without sync_status filter
        cutoff = datetime.now() + timedelta(days=1)
        deleted_files = self.repo.get_deleted_files_for_gc(
            deleted_before=cutoff,
            sync_status=None
        )

        # Should get both files
        self.assertEqual(len(deleted_files), 2)
        file_ids = {f.id for f in deleted_files}
        self.assertEqual(file_ids, {pending.id, synced.id})


if __name__ == '__main__':
    unittest.main()
