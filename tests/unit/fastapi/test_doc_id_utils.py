"""
Unit tests for doc_id_utils and the FileRepository counter method it depends on.

@testCovers fastapi_app/lib/utils/doc_id_utils.py
@testCovers fastapi_app/lib/repository/file_repository.py
"""
import shutil
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.models.models import FileCreate


class TestGetMaxCollectionCounter(unittest.TestCase):
    """Test FileRepository.get_max_collection_counter."""

    def setUp(self):
        self.test_dir = Path(tempfile.mkdtemp())
        self.db = DatabaseManager(self.test_dir / "test.db")
        self.repo = FileRepository(self.db)

    def tearDown(self):
        import gc
        gc.collect()
        shutil.rmtree(self.test_dir)

    def _insert(self, file_id: str, doc_id: str) -> None:
        self.repo.insert_file(FileCreate(
            id=file_id, filename=f"{file_id}.pdf",
            doc_id=doc_id, file_type='pdf', file_size=100
        ))

    def test_returns_zero_when_no_files(self):
        """Returns 0 when no files match the prefix."""
        self.assertEqual(self.repo.get_max_collection_counter("mycol"), 0)

    def test_returns_max_of_multiple_entries(self):
        """Returns the highest numeric suffix."""
        self._insert("f1", "mycol-0001")
        self._insert("f2", "mycol-0003")
        self._insert("f3", "mycol-0002")
        self.assertEqual(self.repo.get_max_collection_counter("mycol"), 3)

    def test_ignores_different_prefix(self):
        """Does not count files with a different prefix."""
        self._insert("f1", "other-0005")
        self.assertEqual(self.repo.get_max_collection_counter("mycol"), 0)

    def test_ignores_non_numeric_suffixes(self):
        """Files whose suffix is not all digits are not counted."""
        self._insert("f1", "mycol-0001")
        self._insert("f2", "mycol-extra")
        self.assertEqual(self.repo.get_max_collection_counter("mycol"), 1)
