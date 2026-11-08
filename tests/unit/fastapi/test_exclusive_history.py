"""
Unit tests for FileRepository.get_exclusive_history: a version and the ancestors no other version descends from.

@testCovers fastapi_app/lib/repository/file_repository.py::get_exclusive_history
"""

import gc
import shutil
import tempfile
import unittest
from pathlib import Path

from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.models.models import FileCreate
from fastapi_app.lib.repository.file_repository import FileRepository


class TestExclusiveHistory(unittest.TestCase):

    def setUp(self) -> None:
        self.test_dir = Path(tempfile.mkdtemp())
        self.db = DatabaseManager(self.test_dir / "test.db")
        self.repo = FileRepository(self.db)

    def tearDown(self) -> None:
        gc.collect()
        shutil.rmtree(self.test_dir)

    def add(self, stable_id: str, parent: str | None = None, gold: bool = False) -> None:
        """Insert a TEI version with the given parent."""
        self.repo.insert_file(FileCreate(
            id=stable_id.ljust(64, "0"),
            stable_id=stable_id,
            filename=f"{stable_id}.tei.xml",
            doc_id="doc",
            file_type="tei",
            file_size=1,
            version=None if gold else 1,
            is_gold_standard=gold,
            parent_stable_id=parent,
        ))

    def history(self, stable_id: str) -> list[str]:
        return [f.stable_id for f in self.repo.get_exclusive_history(stable_id)]

    def test_deletes_whole_chain_up_to_gold(self) -> None:
        self.add("gold", gold=True)
        self.add("grand", "gold")
        self.add("parent", "grand")
        self.add("child", "parent")
        self.assertEqual(self.history("child"), ["child", "parent", "grand"])

    def test_stops_before_ancestor_with_other_descendants(self) -> None:
        self.add("grand")
        self.add("parent", "grand")
        self.add("child", "parent")
        self.add("sibling-of-parent", "grand")
        self.assertEqual(self.history("child"), ["child", "parent"])

    def test_stops_at_parent_with_other_child(self) -> None:
        self.add("grand")
        self.add("parent", "grand")
        self.add("child", "parent")
        self.add("sibling", "parent")
        self.assertEqual(self.history("child"), ["child"])

    def test_deleted_descendants_do_not_count(self) -> None:
        self.add("grand")
        self.add("parent", "grand")
        self.add("child", "parent")
        self.add("sibling", "parent")
        self.repo.delete_file("sibling".ljust(64, "0"))
        self.assertEqual(self.history("child"), ["child", "parent", "grand"])

    def test_without_parent(self) -> None:
        self.add("single")
        self.assertEqual(self.history("single"), ["single"])
        self.assertEqual(self.history("missing"), [])


if __name__ == "__main__":
    unittest.main()
