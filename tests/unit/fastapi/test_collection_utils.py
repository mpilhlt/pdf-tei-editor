"""
Unit tests for collection_utils.py

Self-contained tests that can be run independently.

@testCovers fastapi_app/lib/utils/collection_utils.py
"""

import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.utils.collection_utils import (
    find_collection,
    collection_exists,
    get_available_collections,
    get_collections_with_details,
    validate_collection,
    add_collection,
    remove_collection,
    set_collection_property,
    list_collections
)
from fastapi_app.lib.utils.data_utils import load_entity_data, save_entity_data
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.models.models import FileCreate


class TestCollectionUtils(unittest.TestCase):
    """Test collection management utilities."""

    def setUp(self):
        """Create temporary directory for each test."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_dir = Path(self.temp_dir.name)

    def tearDown(self):
        """Clean up temporary directory."""
        self.temp_dir.cleanup()

    def test_add_collection(self):
        """Test adding a new collection."""
        success, msg = add_collection(self.db_dir, 'test-collection', 'Test Collection', 'Test description')
        self.assertTrue(success)
        self.assertIn('test-collection', msg)

        # Verify collection was added
        collections = list_collections(self.db_dir)
        self.assertEqual(len(collections), 1)
        self.assertEqual(collections[0]['id'], 'test-collection')
        self.assertEqual(collections[0]['name'], 'Test Collection')
        self.assertEqual(collections[0]['description'], 'Test description')

    def test_add_duplicate_collection(self):
        """Test adding a duplicate collection fails."""
        add_collection(self.db_dir, 'test-collection', 'Test Collection')
        success, msg = add_collection(self.db_dir, 'test-collection', 'Test Collection')
        self.assertFalse(success)
        self.assertIn('already exists', msg)

    def test_remove_collection(self):
        """Test removing a collection."""
        add_collection(self.db_dir, 'test-collection', 'Test Collection')
        success, msg, stats = remove_collection(self.db_dir, 'test-collection')
        self.assertTrue(success)
        self.assertIn('test-collection', msg)
        self.assertEqual(stats['files_updated'], 0)
        self.assertEqual(stats['files_deleted'], 0)

        # Verify collection was removed
        collections = list_collections(self.db_dir)
        self.assertEqual(len(collections), 0)

    def test_remove_nonexistent_collection(self):
        """Test removing a nonexistent collection fails."""
        success, msg, stats = remove_collection(self.db_dir, 'nonexistent')
        self.assertFalse(success)
        self.assertIn('not found', msg)
        self.assertEqual(stats, {})

    def test_set_collection_property(self):
        """Test setting a collection property."""
        add_collection(self.db_dir, 'test-collection', 'Test Collection')
        success, msg = set_collection_property(self.db_dir, 'test-collection', 'name', 'New Name')
        self.assertTrue(success)

        # Verify property was updated
        collections = list_collections(self.db_dir)
        self.assertEqual(collections[0]['name'], 'New Name')

    def test_validate_collection(self):
        """Test collection validation."""
        self.assertFalse(validate_collection('nonexistent', self.db_dir))

        add_collection(self.db_dir, 'test-collection', 'Test Collection')
        self.assertTrue(validate_collection('test-collection', self.db_dir))

    def test_get_available_collections(self):
        """Test getting list of available collections."""
        add_collection(self.db_dir, 'collection1', 'Collection 1')
        add_collection(self.db_dir, 'collection2', 'Collection 2')

        available = get_available_collections(self.db_dir)
        self.assertEqual(len(available), 2)
        self.assertIn('collection1', available)
        self.assertIn('collection2', available)

    def test_get_collections_with_details(self):
        """Test getting collections with full details."""
        add_collection(self.db_dir, 'test-collection', 'Test Collection', 'Description')

        collections = get_collections_with_details(self.db_dir)
        self.assertEqual(len(collections), 1)
        self.assertEqual(collections[0]['id'], 'test-collection')
        self.assertEqual(collections[0]['name'], 'Test Collection')
        self.assertEqual(collections[0]['description'], 'Description')

    def test_find_collection(self):
        """Test finding a collection by ID."""
        add_collection(self.db_dir, 'test-collection', 'Test Collection')
        collections = list_collections(self.db_dir)

        found = find_collection('test-collection', collections)
        self.assertIsNotNone(found)
        self.assertEqual(found['id'], 'test-collection')

        not_found = find_collection('nonexistent', collections)
        self.assertIsNone(not_found)

    def test_collection_exists(self):
        """Test checking if a collection exists."""
        add_collection(self.db_dir, 'test-collection', 'Test Collection')
        collections = list_collections(self.db_dir)

        self.assertTrue(collection_exists('test-collection', collections))
        self.assertFalse(collection_exists('nonexistent', collections))

    def test_remove_collection_updates_file_metadata(self):
        """Test that removing a collection updates files' doc_collections arrays."""
        # Create database and repository
        db_path = self.db_dir / "metadata.db"
        db_manager = DatabaseManager(db_path)
        file_repo = FileRepository(db_manager)

        # Create collections
        add_collection(self.db_dir, 'collection1', 'Collection 1')
        add_collection(self.db_dir, 'collection2', 'Collection 2')

        # Create a file in both collections
        file_data = FileCreate(
            id='a' * 64,
            filename='test.pdf',
            doc_id='test-doc',
            file_type='pdf',
            file_size=1000,
            doc_collections=['collection1', 'collection2']
        )
        file_repo.insert_file(file_data)

        # Remove collection1
        success, msg, stats = remove_collection(self.db_dir, 'collection1')

        # Verify success and stats
        self.assertTrue(success)
        self.assertEqual(stats['files_updated'], 1)
        self.assertEqual(stats['files_deleted'], 0)

        # Verify file still exists with collection2 only
        file = file_repo.get_file_by_id('a' * 64)
        self.assertIsNotNone(file)
        self.assertEqual(file.doc_collections, ['collection2'])
        self.assertFalse(file.deleted)

    def test_remove_collection_deletes_orphaned_files(self):
        """Test that removing a collection marks files with no other collections as deleted."""
        # Create database and repository
        db_path = self.db_dir / "metadata.db"
        db_manager = DatabaseManager(db_path)
        file_repo = FileRepository(db_manager)

        # Create collection
        add_collection(self.db_dir, 'only-collection', 'Only Collection')

        # Create a file in only this collection
        file_data = FileCreate(
            id='b' * 64,
            filename='orphan.pdf',
            doc_id='orphan-doc',
            file_type='pdf',
            file_size=1000,
            doc_collections=['only-collection']
        )
        file_repo.insert_file(file_data)

        # Remove the only collection
        success, msg, stats = remove_collection(self.db_dir, 'only-collection')

        # Verify success and stats
        self.assertTrue(success)
        self.assertEqual(stats['files_updated'], 0)
        self.assertEqual(stats['files_deleted'], 1)

        # Verify file is marked as deleted
        file = file_repo.get_file_by_id('b' * 64, include_deleted=True)
        self.assertIsNotNone(file)
        self.assertTrue(file.deleted)

    def test_remove_collection_mixed_scenario(self):
        """Test removing a collection with a mix of orphaned and non-orphaned files."""
        # Create database and repository
        db_path = self.db_dir / "metadata.db"
        db_manager = DatabaseManager(db_path)
        file_repo = FileRepository(db_manager)

        # Create collections
        add_collection(self.db_dir, 'shared-collection', 'Shared Collection')
        add_collection(self.db_dir, 'other-collection', 'Other Collection')

        # File 1: In both collections (should be updated)
        file_repo.insert_file(FileCreate(
            id='c' * 64,
            filename='file1.pdf',
            doc_id='doc1',
            file_type='pdf',
            file_size=1000,
            doc_collections=['shared-collection', 'other-collection']
        ))

        # File 2: Only in shared-collection (should be deleted)
        file_repo.insert_file(FileCreate(
            id='d' * 64,
            filename='file2.pdf',
            doc_id='doc2',
            file_type='pdf',
            file_size=1000,
            doc_collections=['shared-collection']
        ))

        # File 3: Only in other-collection (should be unaffected)
        file_repo.insert_file(FileCreate(
            id='e' * 64,
            filename='file3.pdf',
            doc_id='doc3',
            file_type='pdf',
            file_size=1000,
            doc_collections=['other-collection']
        ))

        # Remove shared-collection
        success, msg, stats = remove_collection(self.db_dir, 'shared-collection')

        # Verify stats
        self.assertTrue(success)
        self.assertEqual(stats['files_updated'], 1)
        self.assertEqual(stats['files_deleted'], 1)

        # Verify file 1: updated, not deleted
        file1 = file_repo.get_file_by_id('c' * 64)
        self.assertIsNotNone(file1)
        self.assertEqual(file1.doc_collections, ['other-collection'])
        self.assertFalse(file1.deleted)

        # Verify file 2: marked as deleted
        file2 = file_repo.get_file_by_id('d' * 64, include_deleted=True)
        self.assertIsNotNone(file2)
        self.assertTrue(file2.deleted)

        # Verify file 3: unchanged
        file3 = file_repo.get_file_by_id('e' * 64)
        self.assertIsNotNone(file3)
        self.assertEqual(file3.doc_collections, ['other-collection'])
        self.assertFalse(file3.deleted)


if __name__ == '__main__':
    unittest.main()
