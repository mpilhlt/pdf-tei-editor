"""
Tests for project-based collection access resolution.

@testCovers fastapi_app/lib/permissions/user_utils.py
"""

import tempfile
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.utils.data_utils import save_entity_data
from fastapi_app.lib.utils.project_utils import create_project


class TestProjectBasedAccess(unittest.TestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_dir = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def _seed_projects(self, projects_data):
        save_entity_data(self.db_dir, 'projects', projects_data)

    def test_user_gets_collections_from_projects(self):
        from fastapi_app.lib.permissions.user_utils import get_user_collections
        self._seed_projects([
            create_project('p1', 'P1', '', ['alice'], ['col1', 'col2']),
            create_project('p2', 'P2', '', ['bob'], ['col3']),
        ])
        result = get_user_collections({'username': 'alice', 'roles': ['user']}, self.db_dir)
        self.assertIsNotNone(result)
        self.assertIn('col1', result)
        self.assertIn('col2', result)
        self.assertNotIn('col3', result)

    def test_admin_role_gets_wildcard(self):
        from fastapi_app.lib.permissions.user_utils import get_user_collections
        self._seed_projects([])
        result = get_user_collections({'username': 'admin', 'roles': ['*']}, self.db_dir)
        self.assertIsNone(result)

    def test_wildcard_in_project_collections_grants_all(self):
        from fastapi_app.lib.permissions.user_utils import get_user_collections
        self._seed_projects([
            create_project('p1', 'P1', '', ['alice'], ['*']),
        ])
        result = get_user_collections({'username': 'alice', 'roles': ['user']}, self.db_dir)
        self.assertIsNone(result)

    def test_anonymous_user_gets_empty(self):
        from fastapi_app.lib.permissions.user_utils import get_user_collections
        self._seed_projects([])
        result = get_user_collections(None, self.db_dir)
        self.assertEqual(result, [])

    def test_user_in_multiple_projects_gets_union(self):
        from fastapi_app.lib.permissions.user_utils import get_user_collections
        self._seed_projects([
            create_project('p1', 'P1', '', ['alice'], ['col1']),
            create_project('p2', 'P2', '', ['alice'], ['col2']),
        ])
        result = get_user_collections({'username': 'alice', 'roles': ['user']}, self.db_dir)
        self.assertIn('col1', result)
        self.assertIn('col2', result)


if __name__ == '__main__':
    unittest.main()
