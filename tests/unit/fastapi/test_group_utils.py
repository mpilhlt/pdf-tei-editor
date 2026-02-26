"""
Unit tests for group_utils.py

Self-contained tests that can be run independently.

@testCovers fastapi_app/lib/permissions/group_utils.py
"""

import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.permissions.group_utils import (
    find_group,
    group_exists,
    get_available_groups,
    get_groups_with_details,
    validate_group,
    add_group,
    remove_group,
    set_group_property,
    list_groups
)
from fastapi_app.lib.utils.collection_utils import add_collection
from fastapi_app.lib.utils.data_utils import load_entity_data, save_entity_data


class TestGroupUtils(unittest.TestCase):
    """Test group management utilities."""

    def setUp(self):
        """Create temporary directory for each test."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_dir = Path(self.temp_dir.name)

    def tearDown(self):
        """Clean up temporary directory."""
        self.temp_dir.cleanup()

    def test_add_group(self):
        """Test adding a new group."""
        success, msg = add_group(self.db_dir, 'test-group', 'Test Group', 'Test description')
        self.assertTrue(success)
        self.assertIn('test-group', msg)

        # Verify group was added
        groups = list_groups(self.db_dir)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]['id'], 'test-group')
        self.assertEqual(groups[0]['name'], 'Test Group')
        self.assertEqual(groups[0]['description'], 'Test description')
        self.assertEqual(groups[0]['collections'], [])

    def test_add_duplicate_group(self):
        """Test adding a duplicate group fails."""
        add_group(self.db_dir, 'test-group', 'Test Group')
        success, msg = add_group(self.db_dir, 'test-group', 'Test Group')
        self.assertFalse(success)
        self.assertIn('already exists', msg)

    def test_remove_group(self):
        """Test removing a group."""
        add_group(self.db_dir, 'test-group', 'Test Group')
        success, msg = remove_group(self.db_dir, 'test-group')
        self.assertTrue(success)
        self.assertIn('test-group', msg)

        # Verify group was removed
        groups = list_groups(self.db_dir)
        self.assertEqual(len(groups), 0)

    def test_remove_nonexistent_group(self):
        """Test removing a nonexistent group fails."""
        success, msg = remove_group(self.db_dir, 'nonexistent')
        self.assertFalse(success)
        self.assertIn('not found', msg)

    def test_set_group_property(self):
        """Test setting a group property."""
        add_group(self.db_dir, 'test-group', 'Test Group')
        success, msg = set_group_property(self.db_dir, 'test-group', 'name', 'New Name')
        self.assertTrue(success)

        # Verify property was updated
        groups = list_groups(self.db_dir)
        self.assertEqual(groups[0]['name'], 'New Name')

    def test_validate_group(self):
        """Test group validation."""
        self.assertFalse(validate_group('nonexistent', self.db_dir))

        add_group(self.db_dir, 'test-group', 'Test Group')
        self.assertTrue(validate_group('test-group', self.db_dir))

    def test_get_available_groups(self):
        """Test getting list of available groups."""
        add_group(self.db_dir, 'group1', 'Group 1')
        add_group(self.db_dir, 'group2', 'Group 2')

        available = get_available_groups(self.db_dir)
        self.assertEqual(len(available), 2)
        self.assertIn('group1', available)
        self.assertIn('group2', available)

    def test_get_groups_with_details(self):
        """Test getting groups with full details."""
        add_group(self.db_dir, 'test-group', 'Test Group', 'Description')

        groups = get_groups_with_details(self.db_dir)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]['id'], 'test-group')
        self.assertEqual(groups[0]['name'], 'Test Group')
        self.assertEqual(groups[0]['description'], 'Description')

    def test_find_group(self):
        """Test finding a group by ID."""
        add_group(self.db_dir, 'test-group', 'Test Group')
        groups = list_groups(self.db_dir)

        found = find_group('test-group', groups)
        self.assertIsNotNone(found)
        self.assertEqual(found['id'], 'test-group')

        not_found = find_group('nonexistent', groups)
        self.assertIsNone(not_found)

    def test_group_exists(self):
        """Test checking if a group exists."""
        add_group(self.db_dir, 'test-group', 'Test Group')
        groups = list_groups(self.db_dir)

        self.assertTrue(group_exists('test-group', groups))
        self.assertFalse(group_exists('nonexistent', groups))


if __name__ == '__main__':
    unittest.main()
