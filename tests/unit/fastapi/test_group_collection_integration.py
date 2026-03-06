"""
Unit tests for group-collection-user integration

Tests the integration of groups, collections, and users.

@testCovers fastapi_app/lib/permissions/group_utils.py
@testCovers fastapi_app/lib/utils/collection_utils.py
@testCovers fastapi_app/lib/permissions/user_utils.py
"""

import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.permissions.group_utils import (
    add_group,
    add_collection_to_group,
    remove_collection_from_group,
    list_groups
)
from fastapi_app.lib.utils.collection_utils import add_collection
from fastapi_app.lib.permissions.user_utils import (
    add_user,
    add_group_to_user,
    remove_group_from_user,
    list_users
)


class TestGroupCollectionIntegration(unittest.TestCase):
    """Test integration between groups, collections, and users."""

    def setUp(self):
        """Create temporary directory for each test."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_dir = Path(self.temp_dir.name)

    def tearDown(self):
        """Clean up temporary directory."""
        self.temp_dir.cleanup()

    def test_add_collection_to_group(self):
        """Test adding a collection to a group."""
        # Create group and collection
        add_group(self.db_dir, 'test-group', 'Test Group')
        add_collection(self.db_dir, 'test-collection', 'Test Collection')

        # Add collection to group
        success, msg = add_collection_to_group(self.db_dir, 'test-group', 'test-collection')
        self.assertTrue(success)
        self.assertIn('test-collection', msg)
        self.assertIn('test-group', msg)

        # Verify collection was added
        groups = list_groups(self.db_dir)
        self.assertEqual(groups[0]['collections'], ['test-collection'])

    def test_add_invalid_collection_to_group(self):
        """Test adding a nonexistent collection to a group fails."""
        add_group(self.db_dir, 'test-group', 'Test Group')

        success, msg = add_collection_to_group(self.db_dir, 'test-group', 'nonexistent')
        self.assertFalse(success)
        self.assertIn('not a valid collection', msg)

    def test_add_collection_to_invalid_group(self):
        """Test adding a collection to a nonexistent group fails."""
        add_collection(self.db_dir, 'test-collection', 'Test Collection')

        success, msg = add_collection_to_group(self.db_dir, 'nonexistent', 'test-collection')
        self.assertFalse(success)
        self.assertIn('not found', msg)

    def test_remove_collection_from_group(self):
        """Test removing a collection from a group."""
        add_group(self.db_dir, 'test-group', 'Test Group')
        add_collection(self.db_dir, 'test-collection', 'Test Collection')
        add_collection_to_group(self.db_dir, 'test-group', 'test-collection')

        success, msg = remove_collection_from_group(self.db_dir, 'test-group', 'test-collection')
        self.assertTrue(success)

        # Verify collection was removed
        groups = list_groups(self.db_dir)
        self.assertEqual(groups[0]['collections'], [])

    def test_add_duplicate_collection_to_group(self):
        """Test adding the same collection twice to a group fails."""
        add_group(self.db_dir, 'test-group', 'Test Group')
        add_collection(self.db_dir, 'test-collection', 'Test Collection')
        add_collection_to_group(self.db_dir, 'test-group', 'test-collection')

        success, msg = add_collection_to_group(self.db_dir, 'test-group', 'test-collection')
        self.assertFalse(success)
        self.assertIn('already has', msg)

    def test_add_group_to_user(self):
        """Test adding a group to a user."""
        add_user(self.db_dir, 'testuser', 'password123')
        add_group(self.db_dir, 'test-group', 'Test Group')

        success, msg = add_group_to_user(self.db_dir, 'testuser', 'test-group')
        self.assertTrue(success)
        self.assertIn('test-group', msg)
        self.assertIn('testuser', msg)

        # Verify group was added to user
        users = list_users(self.db_dir)
        self.assertIn('test-group', users[0]['groups'])

    def test_add_invalid_group_to_user(self):
        """Test adding a nonexistent group to a user fails."""
        add_user(self.db_dir, 'testuser', 'password123')

        success, msg = add_group_to_user(self.db_dir, 'testuser', 'nonexistent')
        self.assertFalse(success)
        self.assertIn('not a valid group', msg)

    def test_add_group_to_invalid_user(self):
        """Test adding a group to a nonexistent user fails."""
        add_group(self.db_dir, 'test-group', 'Test Group')

        success, msg = add_group_to_user(self.db_dir, 'nonexistent', 'test-group')
        self.assertFalse(success)
        self.assertIn('not found', msg)

    def test_remove_group_from_user(self):
        """Test removing a group from a user."""
        add_user(self.db_dir, 'testuser', 'password123')
        add_group(self.db_dir, 'test-group', 'Test Group')
        add_group_to_user(self.db_dir, 'testuser', 'test-group')

        success, msg = remove_group_from_user(self.db_dir, 'testuser', 'test-group')
        self.assertTrue(success)

        # Verify group was removed from user
        users = list_users(self.db_dir)
        self.assertNotIn('test-group', users[0]['groups'])

    def test_add_duplicate_group_to_user(self):
        """Test adding the same group twice to a user fails."""
        add_user(self.db_dir, 'testuser', 'password123')
        add_group(self.db_dir, 'test-group', 'Test Group')
        add_group_to_user(self.db_dir, 'testuser', 'test-group')

        success, msg = add_group_to_user(self.db_dir, 'testuser', 'test-group')
        self.assertFalse(success)
        self.assertIn('already belongs', msg)

    def test_full_access_control_flow(self):
        """Test a complete access control flow: user -> group -> collection."""
        # Create entities
        add_user(self.db_dir, 'alice', 'password123')
        add_group(self.db_dir, 'editors', 'Editors Group')
        add_collection(self.db_dir, 'documents', 'Documents Collection')

        # Link them together
        add_collection_to_group(self.db_dir, 'editors', 'documents')
        add_group_to_user(self.db_dir, 'alice', 'editors')

        # Verify the complete chain
        users = list_users(self.db_dir)
        groups = list_groups(self.db_dir)

        self.assertEqual(users[0]['username'], 'alice')
        self.assertIn('editors', users[0]['groups'])

        self.assertEqual(groups[0]['id'], 'editors')
        self.assertIn('documents', groups[0]['collections'])


if __name__ == '__main__':
    unittest.main()
