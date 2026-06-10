"""
Unit tests for collection-based access control.

Tests the implementation of collection-based access control in user_utils,
including wildcard support for users, groups, roles, and collections.

@testCovers fastapi_app/lib/permissions/user_utils.py:get_user_collections
@testCovers fastapi_app/lib/permissions/user_utils.py:user_has_collection_access
"""

import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.permissions.user_utils import (
    get_user_collections,
    user_has_collection_access,
    add_user
)
from fastapi_app.lib.utils.collection_utils import add_collection
from fastapi_app.lib.utils.data_utils import save_entity_data
from fastapi_app.lib.utils.project_utils import create_project


class TestCollectionAccessControl(unittest.TestCase):
    """Test collection-based access control."""

    def setUp(self):
        """Create temporary directory and test data for each test."""
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_dir = Path(self.temp_dir.name)

        # Create test collections
        add_collection(self.db_dir, 'col1', 'Collection 1', 'First collection')
        add_collection(self.db_dir, 'col2', 'Collection 2', 'Second collection')
        add_collection(self.db_dir, 'col3', 'Collection 3', 'Third collection')

    def tearDown(self):
        """Clean up temporary directory."""
        self.temp_dir.cleanup()

    def test_anonymous_user_has_no_collections(self):
        """Test that anonymous users have no collection access."""
        collections = get_user_collections(None, self.db_dir)
        self.assertEqual(collections, [])

        has_access = user_has_collection_access(None, 'col1', self.db_dir)
        self.assertFalse(has_access)

    def test_user_with_wildcard_role_has_all_collections(self):
        """Test that users with wildcard role have access to all collections."""
        user = {
            'username': 'admin',
            'roles': ['*'],
            'groups': []
        }

        collections = get_user_collections(user, self.db_dir)
        self.assertIsNone(collections)  # None means all collections

        has_access = user_has_collection_access(user, 'col1', self.db_dir)
        self.assertTrue(has_access)
        has_access = user_has_collection_access(user, 'any-collection', self.db_dir)
        self.assertTrue(has_access)

    def test_user_with_admin_role_without_groups_has_no_collections(self):
        """Test that admin role alone does not grant collection access."""
        user = {
            'username': 'admin',
            'roles': ['admin', 'user'],
            'groups': []
        }

        collections = get_user_collections(user, self.db_dir)
        self.assertEqual(collections, [])  # No groups = no collections

        has_access = user_has_collection_access(user, 'col1', self.db_dir)
        self.assertFalse(has_access)

    def test_user_with_wildcard_groups_has_all_collections(self):
        """Test that users in a project with wildcard collections have access to all collections."""
        save_entity_data(self.db_dir, 'projects', [
            create_project('wildcard-project', 'Wildcard Project', '', ['superuser'], ['*'])
        ])
        user = {
            'username': 'superuser',
            'roles': ['user'],
            'groups': []
        }

        collections = get_user_collections(user, self.db_dir)
        self.assertIsNone(collections)  # None means all collections

        has_access = user_has_collection_access(user, 'col1', self.db_dir)
        self.assertTrue(has_access)

    def test_user_with_specific_group_collections(self):
        """Test that users get collections from their projects."""
        save_entity_data(self.db_dir, 'projects', [
            create_project('project1', 'Project 1', '', ['testuser'], ['col1', 'col2'])
        ])

        user = {
            'username': 'testuser',
            'roles': ['user'],
            'groups': []
        }

        collections = get_user_collections(user, self.db_dir)
        self.assertIsNotNone(collections)
        self.assertIn('col1', collections)
        self.assertIn('col2', collections)
        self.assertNotIn('col3', collections)

        has_access = user_has_collection_access(user, 'col1', self.db_dir)
        self.assertTrue(has_access)
        has_access = user_has_collection_access(user, 'col3', self.db_dir)
        self.assertFalse(has_access)

    def test_user_with_multiple_groups(self):
        """Test that users get collections from all their projects."""
        save_entity_data(self.db_dir, 'projects', [
            create_project('project1', 'Project 1', '', ['testuser'], ['col1']),
            create_project('project2', 'Project 2', '', ['testuser'], ['col2']),
        ])

        user = {
            'username': 'testuser',
            'roles': ['user'],
            'groups': []
        }

        collections = get_user_collections(user, self.db_dir)
        self.assertIsNotNone(collections)
        self.assertIn('col1', collections)
        self.assertIn('col2', collections)
        self.assertNotIn('col3', collections)

    def test_group_with_wildcard_collections(self):
        """Test that projects with wildcard collections grant access to all collections."""
        save_entity_data(self.db_dir, 'projects', [
            create_project('admin-project', 'Admin Project', '', ['testuser'], ['*'])
        ])

        user = {
            'username': 'testuser',
            'roles': ['user'],
            'groups': []
        }

        collections = get_user_collections(user, self.db_dir)
        self.assertIsNone(collections)  # None means all collections

        has_access = user_has_collection_access(user, 'col1', self.db_dir)
        self.assertTrue(has_access)
        has_access = user_has_collection_access(user, 'any-collection', self.db_dir)
        self.assertTrue(has_access)

    def test_user_with_no_groups_has_no_collections(self):
        """Test that users without groups have no collection access."""
        user = {
            'username': 'testuser',
            'roles': ['user'],
            'groups': []
        }

        collections = get_user_collections(user, self.db_dir)
        self.assertEqual(collections, [])

        has_access = user_has_collection_access(user, 'col1', self.db_dir)
        self.assertFalse(has_access)

    def test_user_with_nonexistent_group(self):
        """Test that users with no matching projects have no collection access."""
        user = {
            'username': 'testuser',
            'roles': ['user'],
            'groups': []
        }

        collections = get_user_collections(user, self.db_dir)
        self.assertEqual(collections, [])

        has_access = user_has_collection_access(user, 'col1', self.db_dir)
        self.assertFalse(has_access)

    def test_mixed_wildcard_and_specific_groups(self):
        """Test that having one project with wildcard collections grants access to all."""
        save_entity_data(self.db_dir, 'projects', [
            create_project('project1', 'Project 1', '', ['testuser'], ['col1']),
            create_project('admin-project', 'Admin Project', '', ['testuser'], ['*']),
        ])

        user = {
            'username': 'testuser',
            'roles': ['user'],
            'groups': []
        }

        # Should have access to all collections due to admin-project
        collections = get_user_collections(user, self.db_dir)
        self.assertIsNone(collections)  # None means all collections

        has_access = user_has_collection_access(user, 'col3', self.db_dir)
        self.assertTrue(has_access)


if __name__ == '__main__':
    unittest.main()
