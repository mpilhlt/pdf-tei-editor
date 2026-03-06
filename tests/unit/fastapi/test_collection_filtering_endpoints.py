"""
Unit tests for collection filtering in API endpoints.

Tests that the /files/list and /collections endpoints properly filter
collections based on user access, ensuring users never see collections
they don't have access to.

@testCovers fastapi_app/routers/files_list.py:list_files
@testCovers fastapi_app/routers/collections.py:list_all_collections
"""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
import shutil

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi.testclient import TestClient
from fastapi_app.main import app
from fastapi_app.lib.permissions.user_utils import add_user
from fastapi_app.lib.permissions.group_utils import add_group, add_collection_to_group
from fastapi_app.lib.utils.collection_utils import add_collection
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.models.models import FileMetadata


class TestCollectionFilteringEndpoints(unittest.TestCase):
    """Test collection filtering in API endpoints."""

    def setUp(self):
        """Create temporary directory and test data for each test."""
        self.test_dir = Path(tempfile.mkdtemp())
        self.db_dir = self.test_dir / 'db'
        self.db_dir.mkdir()

        # Create test collections
        add_collection(self.db_dir, 'col1', 'Collection 1', 'First collection')
        add_collection(self.db_dir, 'col2', 'Collection 2', 'Second collection')
        add_collection(self.db_dir, 'col3', 'Collection 3', 'Third collection')

        # Create test groups
        add_group(self.db_dir, 'group1', 'Group 1', 'Has access to col1 and col2')
        add_collection_to_group(self.db_dir, 'group1', 'col1')
        add_collection_to_group(self.db_dir, 'group1', 'col2')

        add_group(self.db_dir, 'group2', 'Group 2', 'Has access to col3')
        add_collection_to_group(self.db_dir, 'group2', 'col3')

        # Create test users
        add_user(self.db_dir, 'user1', 'password123', 'User One', 'user1@example.com')
        add_user(self.db_dir, 'admin', 'admin123', 'Admin User', 'admin@example.com')

        # Add user to group1
        from fastapi_app.lib.permissions.user_utils import add_group_to_user
        add_group_to_user(self.db_dir, 'user1', 'group1')

        # Make admin an admin
        from fastapi_app.lib.permissions.user_utils import add_role_to_user
        add_role_to_user(self.db_dir, 'admin', 'admin')

        # Setup database and repository
        self.db = DatabaseManager(self.test_dir / 'test.db')
        self.repo = FileRepository(self.db)

        # Mock settings to use test db_dir and file repository
        # We need to patch get_settings in multiple places where it's imported
        self.settings_patcher = patch('fastapi_app.config.get_settings')
        self.settings_patcher_routers = patch('fastapi_app.routers.collections.get_settings')
        self.settings_patcher_files_list = patch('fastapi_app.routers.files_list.get_settings')

        mock_settings = self.settings_patcher.start()
        mock_settings_routers = self.settings_patcher_routers.start()
        mock_settings_files_list = self.settings_patcher_files_list.start()

        # Configure all mocks with the same values
        for mock in [mock_settings, mock_settings_routers, mock_settings_files_list]:
            mock.return_value.db_dir = self.db_dir
            mock.return_value.data_dir = self.test_dir / 'files'
            mock.return_value.data_dir.mkdir(exist_ok=True)

        # Setup test client
        self.client = TestClient(app)

        # Override dependencies using FastAPI's dependency_overrides
        from fastapi_app.lib.core.dependencies import get_file_repository
        app.dependency_overrides[get_file_repository] = lambda: self.repo

    def tearDown(self):
        """Clean up temporary directory."""
        import gc
        # Clear dependency overrides
        app.dependency_overrides.clear()
        self.settings_patcher.stop()
        self.settings_patcher_routers.stop()
        self.settings_patcher_files_list.stop()
        del self.db
        del self.repo
        gc.collect()  # Force garbage collection to close database connections
        shutil.rmtree(self.test_dir)

    def _create_mock_user(self, username: str, roles: list, groups: list) -> dict:
        """Create a mock user dict for dependency injection."""
        return {
            'username': username,
            'roles': roles,
            'groups': groups,
            'session_id': 'test-session'
        }

    def _add_test_file(self, doc_id: str, collections: list, file_type: str = 'pdf'):
        """Add a test file to the repository."""
        from fastapi_app.lib.models.models import FileCreate
        import hashlib
        content_hash = hashlib.sha256(f'{doc_id}-{file_type}'.encode()).hexdigest()

        file_data = FileCreate(
            id=content_hash,  # Content hash
            doc_id=doc_id,
            filename=f'{doc_id}.{file_type}',
            file_type=file_type,
            file_size=1000,
            doc_collections=collections,
            doc_metadata={'title': f'Document {doc_id}'}
        )
        self.repo.insert_file(file_data)

    def _call_with_user(self, user: dict, url: str):
        """Make a request with a specific user by overriding dependencies."""
        from fastapi_app.lib.core.dependencies import get_current_user, get_session_id
        app.dependency_overrides[get_current_user] = lambda: user
        app.dependency_overrides[get_session_id] = lambda: 'test-session'

        try:
            response = self.client.get(url)
            return response
        finally:
            # Clean up overrides
            if get_current_user in app.dependency_overrides:
                del app.dependency_overrides[get_current_user]
            if get_session_id in app.dependency_overrides:
                del app.dependency_overrides[get_session_id]

    def test_files_list_filters_document_collections(self):
        """Test that /files/list filters collections within documents."""
        self._add_test_file('doc1', ['col1', 'col2', 'col3'])
        user1 = self._create_mock_user('user1', ['user'], ['group1'])

        response = self._call_with_user(user1, '/api/v1/files/list')

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data['files']), 1)

        doc = data['files'][0]
        self.assertEqual(doc['doc_id'], 'doc1')
        self.assertEqual(set(doc['collections']), {'col1', 'col2'})
        self.assertNotIn('col3', doc['collections'])

    def test_files_list_excludes_documents_with_no_accessible_collections(self):
        """Test that documents with no accessible collections are excluded."""
        self._add_test_file('doc2', ['col3'])
        self._add_test_file('doc3', ['col1'])
        user1 = self._create_mock_user('user1', ['user'], ['group1'])

        response = self._call_with_user(user1, '/api/v1/files/list')

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data['files']), 1)
        self.assertEqual(data['files'][0]['doc_id'], 'doc3')

    def test_files_list_admin_with_wildcard_group_sees_all_collections(self):
        """Test that users with wildcard group access see all collections."""
        self._add_test_file('doc1', ['col1', 'col2', 'col3'])
        admin = self._create_mock_user('admin', ['admin', 'user'], ['*'])

        response = self._call_with_user(admin, '/api/v1/files/list')

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data['files']), 1)
        doc = data['files'][0]
        self.assertEqual(set(doc['collections']), {'col1', 'col2', 'col3'})

    def test_collections_list_filters_by_user_access(self):
        """Test that /collections endpoint filters collections by user access."""
        user1 = self._create_mock_user('user1', ['user'], ['group1'])

        response = self._call_with_user(user1, '/api/v1/collections')

        self.assertEqual(response.status_code, 200)
        collections = response.json()
        collection_ids = {col['id'] for col in collections}
        self.assertEqual(collection_ids, {'col1', 'col2'})
        self.assertNotIn('col3', collection_ids)

    def test_collections_list_wildcard_group_sees_all(self):
        """Test that users with wildcard group access see all collections."""
        admin = self._create_mock_user('admin', ['admin', 'user'], ['*'])

        response = self._call_with_user(admin, '/api/v1/collections')

        self.assertEqual(response.status_code, 200)
        collections = response.json()
        collection_ids = {col['id'] for col in collections}
        self.assertEqual(collection_ids, {'col1', 'col2', 'col3'})

    def test_files_list_with_multiple_files_in_mixed_collections(self):
        """Test filtering with multiple files in various collection combinations."""
        self._add_test_file('doc1', ['col1', 'col2'])
        self._add_test_file('doc2', ['col2', 'col3'])
        self._add_test_file('doc3', ['col3'])
        self._add_test_file('doc4', ['col1'])
        user1 = self._create_mock_user('user1', ['user'], ['group1'])

        response = self._call_with_user(user1, '/api/v1/files/list')

        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data['files']), 3)
        doc_ids = {doc['doc_id'] for doc in data['files']}
        self.assertEqual(doc_ids, {'doc1', 'doc2', 'doc4'})

        doc1 = next(d for d in data['files'] if d['doc_id'] == 'doc1')
        self.assertEqual(set(doc1['collections']), {'col1', 'col2'})

        doc2 = next(d for d in data['files'] if d['doc_id'] == 'doc2')
        self.assertEqual(doc2['collections'], ['col2'])

        doc4 = next(d for d in data['files'] if d['doc_id'] == 'doc4')
        self.assertEqual(doc4['collections'], ['col1'])

    def test_user_with_no_groups_sees_no_collections(self):
        """Test that users with no groups see no collections or files."""
        add_user(self.db_dir, 'nogroup', 'password', 'No Group User', 'nogroup@example.com')
        self._add_test_file('doc1', ['col1'])
        user_nogroup = self._create_mock_user('nogroup', ['user'], [])

        response = self._call_with_user(user_nogroup, '/api/v1/files/list')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()['files']), 0)

        response = self._call_with_user(user_nogroup, '/api/v1/collections')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()), 0)


if __name__ == '__main__':
    unittest.main()
