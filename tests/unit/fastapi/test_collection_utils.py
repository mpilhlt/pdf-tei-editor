"""
Unit tests for collection_utils.py

Self-contained tests that can be run independently.

@testCovers fastapi_app/lib/collection_utils.py
"""

import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.collection_utils import (
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
from fastapi_app.lib.data_utils import load_entity_data, save_entity_data


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
        success, msg = remove_collection(self.db_dir, 'test-collection')
        self.assertTrue(success)
        self.assertIn('test-collection', msg)

        # Verify collection was removed
        collections = list_collections(self.db_dir)
        self.assertEqual(len(collections), 0)

    def test_remove_nonexistent_collection(self):
        """Test removing a nonexistent collection fails."""
        success, msg = remove_collection(self.db_dir, 'nonexistent')
        self.assertFalse(success)
        self.assertIn('not found', msg)

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


if __name__ == '__main__':
    unittest.main()
