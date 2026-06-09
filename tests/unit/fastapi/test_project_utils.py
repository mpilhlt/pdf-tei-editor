"""
Unit tests for project_utils.py

@testCovers fastapi_app/lib/utils/project_utils.py
"""

import tempfile
import unittest
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))

from fastapi_app.lib.utils.data_utils import load_entity_data, save_entity_data


class TestProjectUtils(unittest.TestCase):

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_dir = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_create_project(self):
        from fastapi_app.lib.utils.project_utils import create_project
        p = create_project('proj1', 'Project One', 'desc', ['alice'], ['col1'])
        self.assertEqual(p['id'], 'proj1')
        self.assertEqual(p['name'], 'Project One')
        self.assertEqual(p['members'], ['alice'])
        self.assertEqual(p['collections'], ['col1'])
        self.assertEqual(p['config'], {})

    def test_find_project(self):
        from fastapi_app.lib.utils.project_utils import find_project, create_project
        projects = [create_project('p1', 'P1', '', [], [])]
        result = find_project('p1', projects)
        self.assertIsNotNone(result)
        self.assertEqual(result['id'], 'p1')

    def test_find_project_missing(self):
        from fastapi_app.lib.utils.project_utils import find_project
        self.assertIsNone(find_project('nope', []))

    def test_project_exists(self):
        from fastapi_app.lib.utils.project_utils import project_exists, create_project
        projects = [create_project('p1', 'P1', '', [], [])]
        self.assertTrue(project_exists('p1', projects))
        self.assertFalse(project_exists('p2', projects))

    def test_get_projects_with_details(self):
        from fastapi_app.lib.utils.project_utils import get_projects_with_details, create_project
        save_entity_data(self.db_dir, 'projects', [create_project('p1', 'P1', '', [], [])])
        result = get_projects_with_details(self.db_dir)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['id'], 'p1')

    def test_get_user_projects(self):
        from fastapi_app.lib.utils.project_utils import create_project, get_user_projects
        projects = [
            create_project('p1', 'P1', '', ['alice', 'bob'], ['c1']),
            create_project('p2', 'P2', '', ['bob'], ['c2']),
        ]
        save_entity_data(self.db_dir, 'projects', projects)
        result = get_user_projects({'username': 'alice'}, self.db_dir)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['id'], 'p1')

    def test_get_project_for_collection(self):
        from fastapi_app.lib.utils.project_utils import create_project, get_project_for_collection
        projects = [
            create_project('p1', 'P1', '', [], ['col1', 'col2']),
            create_project('p2', 'P2', '', [], ['col3']),
        ]
        save_entity_data(self.db_dir, 'projects', projects)
        result = get_project_for_collection('col3', self.db_dir)
        self.assertIsNotNone(result)
        self.assertEqual(result['id'], 'p2')

    def test_get_project_for_collection_not_found(self):
        from fastapi_app.lib.utils.project_utils import get_project_for_collection
        save_entity_data(self.db_dir, 'projects', [])
        self.assertIsNone(get_project_for_collection('missing', self.db_dir))

    def test_add_member_to_project(self):
        from fastapi_app.lib.utils.project_utils import create_project, add_member_to_project
        save_entity_data(self.db_dir, 'projects', [create_project('p1', 'P1', '', [], [])])
        ok, _ = add_member_to_project(self.db_dir, 'p1', 'alice')
        self.assertTrue(ok)
        from fastapi_app.lib.utils.project_utils import get_projects_with_details
        p = get_projects_with_details(self.db_dir)[0]
        self.assertIn('alice', p['members'])

    def test_remove_member_from_project(self):
        from fastapi_app.lib.utils.project_utils import create_project, remove_member_from_project
        save_entity_data(self.db_dir, 'projects', [create_project('p1', 'P1', '', ['alice'], [])])
        ok, _ = remove_member_from_project(self.db_dir, 'p1', 'alice')
        self.assertTrue(ok)
        from fastapi_app.lib.utils.project_utils import get_projects_with_details
        p = get_projects_with_details(self.db_dir)[0]
        self.assertNotIn('alice', p['members'])

    def test_add_member_duplicate(self):
        from fastapi_app.lib.utils.project_utils import create_project, add_member_to_project
        save_entity_data(self.db_dir, 'projects', [create_project('p1', 'P1', '', ['alice'], [])])
        ok, msg = add_member_to_project(self.db_dir, 'p1', 'alice')
        self.assertFalse(ok)
        self.assertIn('already', msg)

    def test_remove_member_nonexistent(self):
        from fastapi_app.lib.utils.project_utils import create_project, remove_member_from_project
        save_entity_data(self.db_dir, 'projects', [create_project('p1', 'P1', '', [], [])])
        ok, msg = remove_member_from_project(self.db_dir, 'p1', 'nobody')
        self.assertFalse(ok)
        self.assertIn('not a member', msg)

    def test_add_member_project_not_found(self):
        from fastapi_app.lib.utils.project_utils import add_member_to_project
        save_entity_data(self.db_dir, 'projects', [])
        ok, msg = add_member_to_project(self.db_dir, 'ghost', 'alice')
        self.assertFalse(ok)
        self.assertIn('not found', msg)

    def test_get_user_projects_with_none_user(self):
        from fastapi_app.lib.utils.project_utils import get_user_projects
        result = get_user_projects(None, self.db_dir)
        self.assertEqual(result, [])


if __name__ == '__main__':
    unittest.main()
