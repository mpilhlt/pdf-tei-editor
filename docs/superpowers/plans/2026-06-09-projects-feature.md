# Projects Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a "project" entity that replaces groups as the primary access-control and config-override unit, linking users directly to collections via project membership.

**Architecture:** Projects are stored in `data/db/projects.json` (mirroring `groups.json`). The backend `project_utils.py` library and `projects.py` router follow the exact same patterns as their group counterparts. `get_user_collections()` is updated to iterate projects instead of groups. The frontend loads projects into state and renders them as parent nodes in the file-selection drawer and as group headers in the collection selectbox.

**Tech Stack:** Python/FastAPI (backend), vanilla JS/Shoelace (frontend), node:test (API integration tests), unittest (Python unit tests)

---

## File Map

**Create:**
- `config/projects.json` — default empty projects list for new installs
- `fastapi_app/lib/utils/project_utils.py` — project CRUD + config + migration
- `fastapi_app/routers/projects.py` — REST CRUD routes for `/api/v1/projects`
- `tests/unit/fastapi/test_project_utils.py` — unit tests for project_utils
- `tests/api/v1/projects.test.js` — API integration tests for projects routes

**Modify:**
- `fastapi_app/lib/utils/data_utils.py` — add `'projects'` to `ENTITY_FILES`
- `fastapi_app/lib/permissions/user_utils.py` — update `get_user_collections()` to use projects
- `fastapi_app/main.py` — register projects router; run groups→projects migration at startup
- `fastapi_app/api/config.py` — replace `?collection=` with `?project=`
- `fastapi_app/routers/files_upload.py` — use project config for default-visibility/editability
- `fastapi_app/routers/extraction.py` — use project config for annotation.lifecycle
- `fastapi_app/routers/files_repopulate.py` — add `?project=` param
- `fastapi_app/routers/validation.py` — add `?project=` param for schema.base-url
- `app/src/state.js` — add `project` and `projects` state properties
- `app/src/modules/rbac/entity-schemas.js` — add `project` entity schema
- `app/src/plugins/filedata.js` — fetch projects alongside collections; set `project` in state
- `app/src/plugins/config.js` — reload config on `project` change instead of `collectionFilter`
- `app/src/plugins/file-selection.js` — group selectbox options by project; dispatch `project` on collection change
- `app/src/plugins/file-selection-drawer.js` — render projects as tree parent nodes; set `project` on selection

---

## Task 1: Feature Branch and Data Registry Setup

**Files:**
- Create: `config/projects.json`
- Modify: `fastapi_app/lib/utils/data_utils.py:11-14`

- [ ] **Step 1: Create feature branch**

```bash
git checkout -b feature/projects
```

- [ ] **Step 2: Create `config/projects.json`**

```json
[]
```

Save to `config/projects.json`.

- [ ] **Step 3: Register `projects` in `data_utils.py`**

In `fastapi_app/lib/utils/data_utils.py`, the `ENTITY_FILES` dict (around line 11) currently has entries for `users`, `roles`, `groups`, and `collections`. Add `projects`:

```python
ENTITY_FILES = {
    'users': 'users.json',
    'roles': 'roles.json',
    'groups': 'groups.json',
    'collections': 'collections.json',
    'projects': 'projects.json',
}
```

- [ ] **Step 4: Verify `load_entity_data` works for projects**

```bash
uv run python -c "
from pathlib import Path
from fastapi_app.lib.utils.data_utils import load_entity_data
import tempfile, json
with tempfile.TemporaryDirectory() as d:
    db = Path(d)
    (db / 'projects.json').write_text('[]')
    result = load_entity_data(db, 'projects')
    print('OK:', result)
"
```

Expected: `OK: []`

- [ ] **Step 5: Commit**

```bash
git add config/projects.json fastapi_app/lib/utils/data_utils.py
git commit -m "chore: add projects.json default config and register in data_utils"
```

---

## Task 2: `project_utils.py` — Core CRUD Functions

**Files:**
- Create: `fastapi_app/lib/utils/project_utils.py`
- Create: `tests/unit/fastapi/test_project_utils.py`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/fastapi/test_project_utils.py`:

```python
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


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
uv run python -m pytest tests/unit/fastapi/test_project_utils.py -v 2>&1 | head -30
```

Expected: `ImportError: cannot import name 'create_project' from 'fastapi_app.lib.utils.project_utils'` or `ModuleNotFoundError`.

- [ ] **Step 3: Create `fastapi_app/lib/utils/project_utils.py`**

```python
"""Project management utilities for PDF-TEI-Editor."""

from pathlib import Path
from typing import Any, Optional
from fastapi_app.lib.utils.data_utils import load_entity_data, save_entity_data


def find_project(project_id: str, projects_data: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Return the project with the given ID, or None."""
    for project in projects_data:
        if project.get('id') == project_id:
            return project
    return None


def project_exists(project_id: str, projects_data: list[dict[str, Any]]) -> bool:
    """Return True if a project with project_id exists in projects_data."""
    return find_project(project_id, projects_data) is not None


def create_project(
    project_id: str,
    name: str,
    description: str = "",
    members: Optional[list[str]] = None,
    collections: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Return a new project dict (not yet persisted)."""
    return {
        "id": project_id,
        "name": name,
        "description": description,
        "members": members or [],
        "collections": collections or [],
        "config": {},
    }


def get_projects_with_details(db_dir: Path) -> list[dict[str, Any]]:
    """Load and return all project dicts from projects.json."""
    return load_entity_data(db_dir, 'projects')


def get_user_projects(
    user: Optional[dict[str, Any]],
    db_dir: Path,
) -> list[dict[str, Any]]:
    """Return all projects where user appears in members[]."""
    if not user:
        return []
    username = user.get('username', '')
    projects = get_projects_with_details(db_dir)
    return [p for p in projects if username in p.get('members', [])]


def get_project_for_collection(
    collection_id: str,
    db_dir: Path,
) -> Optional[dict[str, Any]]:
    """Return the first project that includes collection_id, or None."""
    for project in get_projects_with_details(db_dir):
        if collection_id in project.get('collections', []):
            return project
    return None


def add_member_to_project(
    db_dir: Path,
    project_id: str,
    username: str,
) -> tuple[bool, str]:
    """Add username to project members. Returns (success, message)."""
    projects = load_entity_data(db_dir, 'projects')
    project = find_project(project_id, projects)
    if not project:
        return False, f"Project '{project_id}' not found."
    if username in project.get('members', []):
        return False, f"'{username}' is already a member of '{project_id}'."
    project.setdefault('members', []).append(username)
    save_entity_data(db_dir, 'projects', projects)
    return True, f"Added '{username}' to project '{project_id}'."


def remove_member_from_project(
    db_dir: Path,
    project_id: str,
    username: str,
) -> tuple[bool, str]:
    """Remove username from project members. Returns (success, message)."""
    projects = load_entity_data(db_dir, 'projects')
    project = find_project(project_id, projects)
    if not project:
        return False, f"Project '{project_id}' not found."
    members = project.get('members', [])
    if username not in members:
        return False, f"'{username}' is not a member of '{project_id}'."
    members.remove(username)
    project['members'] = members
    save_entity_data(db_dir, 'projects', projects)
    return True, f"Removed '{username}' from project '{project_id}'."
```

- [ ] **Step 4: Run tests**

```bash
uv run python -m pytest tests/unit/fastapi/test_project_utils.py -v 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/utils/project_utils.py tests/unit/fastapi/test_project_utils.py
git commit -m "feat: add project_utils.py with CRUD and membership helpers"
```

---

## Task 3: `project_utils.py` — Config Functions

**Files:**
- Modify: `fastapi_app/lib/utils/project_utils.py` (append)
- Modify: `tests/unit/fastapi/test_project_utils.py` (append)

- [ ] **Step 1: Add config tests to `test_project_utils.py`**

Append to the `TestProjectUtils` class:

```python
    def test_project_config_set_and_get(self):
        from fastapi_app.lib.utils.project_utils import (
            create_project, project_config_set, project_config_get
        )
        save_entity_data(self.db_dir, 'projects', [create_project('p1', 'P1', '', [], [])])
        ok, _ = project_config_set(self.db_dir, 'p1', 'some.key', 'value1')
        self.assertTrue(ok)
        result = project_config_get(self.db_dir, 'p1', 'some.key')
        self.assertEqual(result, 'value1')

    def test_project_config_get_fallback(self):
        from fastapi_app.lib.utils.project_utils import create_project, project_config_get
        save_entity_data(self.db_dir, 'projects', [create_project('p1', 'P1', '', [], [])])
        result = project_config_get(self.db_dir, 'p1', 'missing.key', default='fallback')
        self.assertEqual(result, 'fallback')

    def test_project_config_get_all(self):
        from fastapi_app.lib.utils.project_utils import (
            create_project, project_config_set, project_config_get_all
        )
        save_entity_data(self.db_dir, 'projects', [create_project('p1', 'P1', '', [], [])])
        project_config_set(self.db_dir, 'p1', 'k1', 'v1')
        project_config_set(self.db_dir, 'p1', 'k2', 'v2')
        result = project_config_get_all(self.db_dir, 'p1')
        self.assertEqual(result, {'k1': 'v1', 'k2': 'v2'})

    def test_project_config_delete(self):
        from fastapi_app.lib.utils.project_utils import (
            create_project, project_config_set, project_config_delete, project_config_get_all
        )
        save_entity_data(self.db_dir, 'projects', [create_project('p1', 'P1', '', [], [])])
        project_config_set(self.db_dir, 'p1', 'k1', 'v1')
        ok, _ = project_config_delete(self.db_dir, 'p1', 'k1')
        self.assertTrue(ok)
        self.assertEqual(project_config_get_all(self.db_dir, 'p1'), {})

    def test_project_config_delete_missing_key(self):
        from fastapi_app.lib.utils.project_utils import create_project, project_config_delete
        save_entity_data(self.db_dir, 'projects', [create_project('p1', 'P1', '', [], [])])
        ok, msg = project_config_delete(self.db_dir, 'p1', 'nope')
        self.assertFalse(ok)
```

- [ ] **Step 2: Run to confirm new tests fail**

```bash
uv run python -m pytest tests/unit/fastapi/test_project_utils.py::TestProjectUtils::test_project_config_set_and_get -v 2>&1 | tail -5
```

Expected: `ImportError` or `AttributeError`.

- [ ] **Step 3: Append config functions to `project_utils.py`**

```python
def project_config_get_all(db_dir: Path, project_id: str) -> dict[str, Any]:
    """Return all config overrides for a project."""
    projects = load_entity_data(db_dir, 'projects')
    project = find_project(project_id, projects)
    if not project:
        return {}
    return dict(project.get('config') or {})


def project_config_get(
    db_dir: Path,
    project_id: str,
    key: str,
    use_default: bool = True,
    default: Any = None,
) -> Any:
    """Return project config override for key, falling back to global config."""
    overrides = project_config_get_all(db_dir, project_id)
    if key in overrides:
        return overrides[key]
    if use_default:
        from fastapi_app.lib.utils.config_utils import get_config_value
        return get_config_value(key, db_dir, default)
    return default


def project_config_set(
    db_dir: Path,
    project_id: str,
    key: str,
    value: Any,
) -> tuple[bool, str]:
    """Set a project-specific config override."""
    projects = load_entity_data(db_dir, 'projects')
    project = find_project(project_id, projects)
    if not project:
        return False, f"Project '{project_id}' not found."
    project['config'] = project.get('config') or {}
    project['config'][key] = value
    save_entity_data(db_dir, 'projects', projects)
    return True, f"Set project config '{key}' for '{project_id}'."


def project_config_delete(
    db_dir: Path,
    project_id: str,
    key: str,
) -> tuple[bool, str]:
    """Delete a project-specific config override."""
    projects = load_entity_data(db_dir, 'projects')
    project = find_project(project_id, projects)
    if not project:
        return False, f"Project '{project_id}' not found."
    config_overrides = project.get('config') or {}
    if key not in config_overrides:
        return False, f"Key '{key}' not in project config overrides."
    del config_overrides[key]
    project['config'] = config_overrides
    save_entity_data(db_dir, 'projects', projects)
    return True, f"Deleted project config '{key}' for '{project_id}'."
```

- [ ] **Step 4: Run all project_utils tests**

```bash
uv run python -m pytest tests/unit/fastapi/test_project_utils.py -v 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/utils/project_utils.py tests/unit/fastapi/test_project_utils.py
git commit -m "feat: add project config get/set/delete to project_utils"
```

---

## Task 4: Groups-to-Projects Migration

**Files:**
- Modify: `fastapi_app/lib/utils/project_utils.py` (append)
- Modify: `tests/unit/fastapi/test_project_utils.py` (append)

- [ ] **Step 1: Add migration test**

Append to `TestProjectUtils`:

```python
    def test_migrate_groups_to_projects(self):
        from fastapi_app.lib.utils.project_utils import migrate_groups_to_projects
        # Seed groups.json
        save_entity_data(self.db_dir, 'groups', [
            {'id': 'team-a', 'name': 'Team A', 'description': 'Desc', 'collections': ['col1', 'col2']},
            {'id': 'admin', 'name': 'Admin', 'description': '', 'collections': ['*']},
        ])
        # Seed users.json
        save_entity_data(self.db_dir, 'users', [
            {'username': 'alice', 'groups': ['team-a']},
            {'username': 'bob', 'groups': ['team-a', 'admin']},
            {'username': 'carol', 'groups': ['admin']},
        ])
        # Empty projects.json
        save_entity_data(self.db_dir, 'projects', [])

        migrate_groups_to_projects(self.db_dir)

        from fastapi_app.lib.utils.project_utils import get_projects_with_details
        projects = get_projects_with_details(self.db_dir)
        self.assertEqual(len(projects), 2)

        team_a = next(p for p in projects if p['id'] == 'team-a')
        self.assertEqual(sorted(team_a['members']), ['alice', 'bob'])
        self.assertEqual(sorted(team_a['collections']), ['col1', 'col2'])

        admin_proj = next(p for p in projects if p['id'] == 'admin')
        self.assertIn('carol', admin_proj['members'])
        self.assertIn('*', admin_proj['collections'])

    def test_migrate_groups_to_projects_idempotent(self):
        from fastapi_app.lib.utils.project_utils import migrate_groups_to_projects
        save_entity_data(self.db_dir, 'groups', [
            {'id': 'team-a', 'name': 'Team A', 'description': '', 'collections': ['col1']},
        ])
        save_entity_data(self.db_dir, 'users', [
            {'username': 'alice', 'groups': ['team-a']},
        ])
        # Pre-existing project with same id
        save_entity_data(self.db_dir, 'projects', [
            {'id': 'team-a', 'name': 'Already Migrated', 'description': '', 'members': ['bob'], 'collections': ['col1'], 'config': {}}
        ])
        migrate_groups_to_projects(self.db_dir)

        from fastapi_app.lib.utils.project_utils import get_projects_with_details
        projects = get_projects_with_details(self.db_dir)
        # Should not create duplicate; original preserved
        self.assertEqual(len(projects), 1)
        self.assertEqual(projects[0]['name'], 'Already Migrated')
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
uv run python -m pytest tests/unit/fastapi/test_project_utils.py::TestProjectUtils::test_migrate_groups_to_projects -v 2>&1 | tail -5
```

- [ ] **Step 3: Append migration function to `project_utils.py`**

```python
def migrate_groups_to_projects(db_dir: Path) -> int:
    """Create a project for each group that does not already have a matching project.

    Members are derived by scanning users.json for users whose groups[] contains the group ID.
    Returns the number of projects created.
    """
    groups = load_entity_data(db_dir, 'groups')
    users = load_entity_data(db_dir, 'users')
    projects = load_entity_data(db_dir, 'projects')
    existing_ids = {p['id'] for p in projects}

    created = 0
    for group in groups:
        gid = group.get('id', '')
        if gid in existing_ids:
            continue
        members = [
            u['username']
            for u in users
            if gid in u.get('groups', [])
        ]
        new_project = create_project(
            project_id=gid,
            name=group.get('name', gid),
            description=group.get('description', ''),
            members=members,
            collections=list(group.get('collections', [])),
        )
        projects.append(new_project)
        created += 1

    if created:
        save_entity_data(db_dir, 'projects', projects)
    return created
```

- [ ] **Step 4: Run all tests**

```bash
uv run python -m pytest tests/unit/fastapi/test_project_utils.py -v 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/lib/utils/project_utils.py tests/unit/fastapi/test_project_utils.py
git commit -m "feat: add migrate_groups_to_projects to project_utils"
```

---

## Task 5: Projects Router

**Files:**
- Create: `fastapi_app/routers/projects.py`

- [ ] **Step 1: Create `fastapi_app/routers/projects.py`**

```python
"""
Projects management API router.

Implements:
- GET /api/v1/projects - List projects visible to the current user
- GET /api/v1/projects/{project_id} - Get project detail
- POST /api/v1/projects - Create project (admin)
- PUT /api/v1/projects/{project_id} - Update project (admin)
- DELETE /api/v1/projects/{project_id} - Delete project (admin)
- GET /api/v1/projects/{project_id}/config - List project config overrides (admin)
- POST /api/v1/projects/{project_id}/config - Set config override (admin)
- DELETE /api/v1/projects/{project_id}/config/{key} - Delete config override (admin)
"""

from typing import Any, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..lib.utils.project_utils import (
    find_project,
    project_exists,
    create_project,
    get_projects_with_details,
    project_config_get_all,
    project_config_set,
    project_config_delete,
)
from ..lib.utils.data_utils import save_entity_data
from ..lib.core.dependencies import get_current_user
from ..lib.utils.logging_utils import get_logger
from ..config import get_settings

logger = get_logger(__name__)
router = APIRouter(prefix="/projects", tags=["projects"])


class Project(BaseModel):
    id: str = Field(..., description="Unique project identifier")
    name: str = Field(..., description="Project display name")
    description: Optional[str] = Field(default="", description="Project description")
    members: list[str] = Field(default=[], description="List of member usernames")
    collections: list[str] = Field(default=[], description="List of collection IDs")


class CreateProjectRequest(BaseModel):
    id: str
    name: str
    description: Optional[str] = ""
    members: Optional[list[str]] = None
    collections: Optional[list[str]] = None


class UpdateProjectRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    members: Optional[list[str]] = None
    collections: Optional[list[str]] = None


class ProjectConfigItem(BaseModel):
    key: str
    value: Any


class ProjectConfigSetRequest(BaseModel):
    key: str
    value: Any


class ProjectConfigResponse(BaseModel):
    project_id: str
    config: dict[str, Any]


def _require_auth(current_user: Optional[dict] = Depends(get_current_user)) -> dict:
    if not current_user:
        raise HTTPException(status_code=401, detail="Authentication required")
    return current_user


def _require_admin(current_user: Optional[dict] = Depends(get_current_user)) -> dict:
    if not current_user:
        raise HTTPException(status_code=401, detail="Authentication required")
    roles = current_user.get('roles', [])
    if '*' not in roles and 'admin' not in roles:
        raise HTTPException(status_code=403, detail="Admin role required")
    return current_user


def _is_admin(user: dict) -> bool:
    roles = user.get('roles', [])
    return '*' in roles or 'admin' in roles


@router.get("", response_model=list[Project])
def list_projects(current_user: dict = Depends(_require_auth)):
    """List projects. Admin sees all; regular users see only projects they are members of."""
    settings = get_settings()
    all_projects = get_projects_with_details(settings.db_dir)
    if _is_admin(current_user):
        return [Project(**{k: p.get(k, Project.__fields__[k].default) for k in Project.__fields__}) for p in all_projects]
    username = current_user.get('username', '')
    return [
        Project(
            id=p['id'], name=p.get('name', ''), description=p.get('description', ''),
            members=p.get('members', []), collections=p.get('collections', [])
        )
        for p in all_projects if username in p.get('members', [])
    ]


@router.get("/{project_id}", response_model=Project)
def get_project(project_id: str, current_user: dict = Depends(_require_auth)):
    """Get project. Returns 404 if not found or if non-admin user is not a member."""
    settings = get_settings()
    all_projects = get_projects_with_details(settings.db_dir)
    project = find_project(project_id, all_projects)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    if not _is_admin(current_user):
        username = current_user.get('username', '')
        if username not in project.get('members', []):
            raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    return Project(
        id=project['id'], name=project.get('name', ''), description=project.get('description', ''),
        members=project.get('members', []), collections=project.get('collections', [])
    )


@router.post("", response_model=Project, status_code=201)
def create_project_endpoint(body: CreateProjectRequest, current_user: dict = Depends(_require_admin)):
    settings = get_settings()
    all_projects = get_projects_with_details(settings.db_dir)
    if project_exists(body.id, all_projects):
        raise HTTPException(status_code=400, detail=f"Project '{body.id}' already exists")
    new_project = create_project(
        project_id=body.id, name=body.name, description=body.description or "",
        members=body.members or [], collections=body.collections or []
    )
    all_projects.append(new_project)
    save_entity_data(settings.db_dir, 'projects', all_projects)
    logger.info(f"Project '{body.id}' created by '{current_user.get('username')}'")
    return Project(id=new_project['id'], name=new_project['name'],
                   description=new_project['description'],
                   members=new_project['members'], collections=new_project['collections'])


@router.put("/{project_id}", response_model=Project)
def update_project_endpoint(project_id: str, body: UpdateProjectRequest,
                             current_user: dict = Depends(_require_admin)):
    settings = get_settings()
    all_projects = get_projects_with_details(settings.db_dir)
    project = find_project(project_id, all_projects)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    if body.name is not None:
        project['name'] = body.name
    if body.description is not None:
        project['description'] = body.description
    if body.members is not None:
        project['members'] = body.members
    if body.collections is not None:
        project['collections'] = body.collections
    save_entity_data(settings.db_dir, 'projects', all_projects)
    logger.info(f"Project '{project_id}' updated by '{current_user.get('username')}'")
    return Project(id=project['id'], name=project.get('name', ''),
                   description=project.get('description', ''),
                   members=project.get('members', []), collections=project.get('collections', []))


@router.delete("/{project_id}")
def delete_project_endpoint(project_id: str, current_user: dict = Depends(_require_admin)):
    settings = get_settings()
    all_projects = get_projects_with_details(settings.db_dir)
    if not project_exists(project_id, all_projects):
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    all_projects = [p for p in all_projects if p.get('id') != project_id]
    save_entity_data(settings.db_dir, 'projects', all_projects)
    logger.info(f"Project '{project_id}' deleted by '{current_user.get('username')}'")
    return {"success": True, "message": f"Project '{project_id}' deleted"}


@router.get("/{project_id}/config", response_model=ProjectConfigResponse)
def get_project_config(project_id: str, current_user: dict = Depends(_require_admin)):
    settings = get_settings()
    all_projects = get_projects_with_details(settings.db_dir)
    if not find_project(project_id, all_projects):
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    overrides = project_config_get_all(settings.db_dir, project_id)
    return ProjectConfigResponse(project_id=project_id, config=overrides)


@router.post("/{project_id}/config", response_model=ProjectConfigItem)
def set_project_config(project_id: str, request_data: ProjectConfigSetRequest,
                       current_user: dict = Depends(_require_admin)):
    settings = get_settings()
    all_projects = get_projects_with_details(settings.db_dir)
    if not find_project(project_id, all_projects):
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    ok, msg = project_config_set(settings.db_dir, project_id, request_data.key, request_data.value)
    if not ok:
        raise HTTPException(status_code=400, detail=msg)
    logger.info(f"'{current_user.get('username')}' set project '{project_id}' config '{request_data.key}'")
    return ProjectConfigItem(key=request_data.key, value=request_data.value)


@router.delete("/{project_id}/config/{key}")
def delete_project_config(project_id: str, key: str, current_user: dict = Depends(_require_admin)):
    settings = get_settings()
    all_projects = get_projects_with_details(settings.db_dir)
    if not find_project(project_id, all_projects):
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found")
    ok, msg = project_config_delete(settings.db_dir, project_id, key)
    if not ok:
        raise HTTPException(status_code=404, detail=msg)
    logger.info(f"'{current_user.get('username')}' deleted project '{project_id}' config '{key}'")
    return {"success": True, "project_id": project_id, "key": key}
```

- [ ] **Step 2: Register router in `fastapi_app/main.py`**

In `fastapi_app/main.py`, find the import block for routers (around line 203) and add:

```python
from .routers import (
    ...
    projects,   # add this line alongside the other router imports
    ...
)
```

Then find where `api_v1.include_router(groups.router)` is called and add the projects router directly before it:

```python
api_v1.include_router(projects.router)
api_v1.include_router(groups.router)
```

- [ ] **Step 3: Run the migration at startup**

In `fastapi_app/main.py`, find the `lifespan` function (around line 22). After the `ensure_db_initialized` call and before the log of startup complete, add:

```python
    # Auto-migrate existing groups to projects on first run
    from .lib.utils.project_utils import migrate_groups_to_projects
    created = migrate_groups_to_projects(settings.db_dir)
    if created:
        logger.info(f"Auto-migrated {created} group(s) to projects")
```

- [ ] **Step 4: Verify server starts without errors**

The dev server auto-reloads on file changes. Confirm no errors appear in the server log. If the server is not running, ask the user to start it with the usual command.

```bash
node bin/debug-api.js GET /api/v1/projects
```

Expected: JSON array (may be empty or contain migrated projects from groups).

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/routers/projects.py fastapi_app/main.py
git commit -m "feat: add projects router and register with auto-migration at startup"
```

---

## Task 6: Update `get_user_collections()` to Use Projects

**Files:**
- Modify: `fastapi_app/lib/permissions/user_utils.py`
- Modify: `tests/unit/fastapi/test_group_collection_integration.py` (or create a new test file)

- [ ] **Step 1: Write failing test**

Create `tests/unit/fastapi/test_project_access.py`:

```python
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
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
uv run python -m pytest tests/unit/fastapi/test_project_access.py -v 2>&1 | tail -10
```

Expected: tests fail because `get_user_collections` still uses groups.

- [ ] **Step 3: Update `get_user_collections()` in `user_utils.py`**

Replace the `get_user_collections` function (starting around line 239) with:

```python
def get_user_collections(user: Optional[Dict[str, Any]], db_dir: Path) -> Optional[List[str]]:
    """Gets all collections accessible to a user based on their project memberships.

    Args:
        user: User dictionary (from authentication), or None for anonymous
        db_dir: Path to the db directory

    Returns:
        List of collection IDs accessible to the user, or None if user has access to all.
        Returns empty list for anonymous users or users in no projects.
    """
    if not user:
        return []

    user_roles = user.get('roles', [])
    if '*' in user_roles:
        return None  # admin wildcard

    from fastapi_app.lib.utils.project_utils import get_user_projects
    user_projects = get_user_projects(user, db_dir)

    accessible: set[str] = set()
    for project in user_projects:
        project_collections = project.get('collections', [])
        if '*' in project_collections:
            return None  # wildcard project
        accessible.update(project_collections)

    return list(accessible)
```

Also update `user_has_collection_access` to remove the old group-based check if any, it can stay as-is since it delegates to `get_user_collections`.

- [ ] **Step 4: Run tests**

```bash
uv run python -m pytest tests/unit/fastapi/test_project_access.py -v 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 5: Run existing group-collection integration tests to confirm they still pass or are now expected-fail**

```bash
uv run python -m pytest tests/unit/fastapi/test_group_collection_integration.py -v 2>&1 | tail -20
```

Note: tests that test `get_user_collections` via groups may fail — that is expected. If they do, update those tests to use project-based setup instead of groups, or mark them as legacy.

- [ ] **Step 6: Commit**

```bash
git add fastapi_app/lib/permissions/user_utils.py tests/unit/fastapi/test_project_access.py
git commit -m "feat: update get_user_collections to use project membership instead of groups"
```

---

## Task 7: Update `/config/list` to Accept `?project=`

**Files:**
- Modify: `fastapi_app/api/config.py`
- Modify: `app/src/plugins/config.js`

- [ ] **Step 1: Update `fastapi_app/api/config.py`**

Find the `list_config` function (around line 102). Replace the `collection` parameter with `project`:

```python
@router.get("/list")
async def list_config(project: Optional[str] = None) -> dict:
    """
    List all configuration values, optionally merged with project-specific overrides.

    If project is provided, project-level config keys override global defaults.
    """
    settings = get_settings()
    base_config = load_full_config(settings.db_dir)

    if project:
        try:
            from ..lib.utils.project_utils import project_config_get_all
            overrides = project_config_get_all(settings.db_dir, project)
            base_config.update(overrides)
        except Exception:
            logger.warning("project_config_get_all failed; ignoring project param")

    return base_config
```

Make sure `load_full_config` is imported at the top of the file from `..lib.utils.config_utils`.

- [ ] **Step 2: Verify the endpoint**

```bash
node bin/debug-api.js GET /api/v1/config/list
```

Expected: JSON config dict.

```bash
node bin/debug-api.js GET "/api/v1/config/list?project=nonexistent"
```

Expected: same config dict (no error, graceful fallback).

- [ ] **Step 3: Update `app/src/plugins/client.js` — `getConfigData`**

`getConfigData` is a hand-written wrapper in `app/src/plugins/client.js` (around line 514). It currently passes `{ collection }` to `configList`. Change the signature and body to use `project`:

```js
/**
 * Fetches all configuration values from the server,
 * optionally filtered by project-specific overrides.
 * @param {string|null} [project] - Project ID to apply overrides for
 * @returns {Promise<Object>}
 */
async function getConfigData(project) {
  return await apiClient.configList(project ? { project } : {});
}
```

- [ ] **Step 4: Update `app/src/plugins/config.js`**

Replace `onCollectionFilterChange` with `onProjectChange`:

```js
  /**
   * Called when the active project changes.
   * Reloads configuration with project-specific overrides applied.
   * @param {string|null} newProject
   * @returns {Promise<void>}
   */
  async onProjectChange(newProject) {
    this.getDependency('logger').debug(`Reloading config for project: ${newProject}`);
    try {
      const response = await this.getDependency('client').getConfigData(newProject || null);
      this._configMap = response || {};
    } catch (error) {
      this.getDependency('logger').error('Failed to reload config for project:', String(error));
    }
  }
```

- [ ] **Step 5: Commit**

```bash
git add fastapi_app/api/config.py app/src/plugins/client.js app/src/plugins/config.js
git commit -m "feat: replace ?collection= with ?project= on /config/list; update config plugin"
```

---

## Task 8: #384 — Update Extraction and Upload Routes

**Files:**
- Modify: `fastapi_app/routers/extraction.py`
- Modify: `fastapi_app/routers/files_upload.py`

- [ ] **Step 1: Update `extraction.py`**

Find where the extraction router reads the collection from options (around line 283):

```python
selected_collection = options.get('collection', '_inbox')
```

After this line, add project config resolution:

```python
from ..lib.utils.project_utils import get_project_for_collection, project_config_get
_project = get_project_for_collection(selected_collection, settings.db_dir)
_project_id = _project['id'] if _project else None
```

Then wherever `collection_config_get` or global config is used for `annotation.lifecycle.*` keys, replace with `project_config_get`:

```python
# Example replacement:
# Before:
#   lifecycle_mode = collection_config_get(settings.db_dir, selected_collection, 'annotation.lifecycle.mode', use_default=True, default='draft')
# After:
lifecycle_mode = (
    project_config_get(settings.db_dir, _project_id, 'annotation.lifecycle.mode', use_default=True, default='draft')
    if _project_id
    else get_config_value('annotation.lifecycle.mode', settings.db_dir, 'draft')
)
```

Apply this pattern to all `annotation.lifecycle.*` and `schema.base-url` lookups in `extraction.py`.

- [ ] **Step 2: Update `files_upload.py`**

Find where the upload router assigns `doc_collections` (around line 192). If there is a `collection` query param, derive the project from it and use project config for `access-control.default-visibility` and `access-control.default-editability`:

```python
from ..lib.utils.project_utils import get_project_for_collection, project_config_get

collection_id = collection or '_inbox'
_project = get_project_for_collection(collection_id, settings.db_dir)
_project_id = _project['id'] if _project else None

default_visibility = (
    project_config_get(settings.db_dir, _project_id, 'access-control.default-visibility',
                       use_default=True, default='private')
    if _project_id
    else get_config_value('access-control.default-visibility', settings.db_dir, 'private')
)
default_editability = (
    project_config_get(settings.db_dir, _project_id, 'access-control.default-editability',
                       use_default=True, default='locked')
    if _project_id
    else get_config_value('access-control.default-editability', settings.db_dir, 'locked')
)
```

- [ ] **Step 3: Verify server still accepts file uploads**

```bash
node bin/debug-api.js GET /api/v1/projects
```

Confirm no server errors in the log.

- [ ] **Step 4: Commit**

```bash
git add fastapi_app/routers/extraction.py fastapi_app/routers/files_upload.py
git commit -m "feat(#384): use project config in extraction and upload routes"
```

---

## Task 9: #384 — Update Validation and Repopulate Routes

**Files:**
- Modify: `fastapi_app/routers/validation.py`
- Modify: `fastapi_app/routers/files_repopulate.py`

- [ ] **Step 1: Update `validation.py`**

Add `project: Optional[str] = None` query parameter to the validation endpoint function signature. Then use project config for `schema.base-url`:

```python
from ..lib.utils.project_utils import project_config_get

# Resolve schema base URL
if project:
    schema_base_url = project_config_get(
        settings.db_dir, project, 'schema.base-url', use_default=True, default=None
    )
else:
    from ..lib.utils.config_utils import get_config_value
    schema_base_url = get_config_value('schema.base-url', settings.db_dir, None)
```

- [ ] **Step 2: Update `files_repopulate.py`**

Add `project: Optional[str] = None` query parameter to the repopulate endpoint. Use project config for `annotation.lifecycle.*` keys the same way as in Task 8.

- [ ] **Step 3: Verify**

```bash
node bin/debug-api.js GET /api/v1/validation
```

Expected: normal validation response (no errors).

- [ ] **Step 4: Commit**

```bash
git add fastapi_app/routers/validation.py fastapi_app/routers/files_repopulate.py
git commit -m "feat(#384): add ?project= param to validation and repopulate routes"
```

---

## Task 10: Regenerate API Client

**Files:**
- Modify: `app/src/modules/api-client-v1.js` (auto-generated)

- [ ] **Step 1: Regenerate**

```bash
npm run generate-client
```

- [ ] **Step 2: Verify projects methods appeared**

```bash
grep -n "listProjects\|getProjects\|createProject\|updateProject\|deleteProject" app/src/modules/api-client-v1.js | head -20
```

Expected: several method definitions for project CRUD.

- [ ] **Step 3: Verify config list uses project param**

```bash
grep -n "listConfig\|getConfigData\|project" app/src/modules/api-client-v1.js | head -10
```

Expected: `listConfig` now accepts a `project` parameter instead of `collection`.

- [ ] **Step 4: Commit**

```bash
git add app/src/modules/api-client-v1.js
git commit -m "chore: regenerate API client with projects routes and ?project= param"
```

---

## Task 11: Frontend State and RBAC Schema

**Files:**
- Modify: `app/src/state.js`
- Modify: `app/src/modules/rbac/entity-schemas.js`

- [ ] **Step 1: Update `app/src/state.js`**

Add the `ProjectInfo` typedef before `ApplicationState`:

```js
/**
 * Project information
 * @typedef {object} ProjectInfo
 * @property {string} id - Unique project identifier
 * @property {string} name - Project display name
 * @property {string} description - Project description
 * @property {string[]} collections - Collection IDs in this project
 * @property {string[]} members - Member usernames
 */
```

Add to the `ApplicationState` typedef (after the `collections` line):

```js
 * @property {string|null} project - ID of the project owning the current collection; null if none
 * @property {ProjectInfo[]|null} projects - All projects accessible to the current user
```

Add to `initialState`:

```js
  project: null,
  projects: null,
```

- [ ] **Step 2: Add project entity schema to `entity-schemas.js`**

In `app/src/modules/rbac/entity-schemas.js`, add the `project` key to `entitySchemas` immediately before `group`:

```js
  project: {
    label: 'Projects',
    singularLabel: 'Project',
    idField: 'id',
    icon: 'folder2-open',
    fields: [
      {
        name: 'id',
        type: 'string',
        label: 'ID',
        required: true,
        immutable: true,
        placeholder: 'project-id',
        helpText: 'Unique project identifier'
      },
      {
        name: 'name',
        type: 'string',
        label: 'Name',
        required: true,
        placeholder: 'Project Name'
      },
      {
        name: 'description',
        type: 'textarea',
        label: 'Description',
        placeholder: 'Describe the project purpose'
      },
      {
        name: 'members',
        type: 'multiselect',
        label: 'Members',
        options: 'user',
        helpText: 'Users with access to this project'
      },
      {
        name: 'collections',
        type: 'multiselect',
        label: 'Collections',
        options: 'collection',
        helpText: 'Collections included in this project'
      }
    ],
    relationships: [
      { target: 'user', field: 'members', type: 'many-to-many' },
      { target: 'collection', field: 'collections', type: 'many-to-many' }
    ]
  },
```

Also update the `helpText` on the `group` schema's `collections` field:

```js
helpText: 'Legacy: collection access is now managed via Projects'
```

- [ ] **Step 3: Commit**

```bash
git add app/src/state.js app/src/modules/rbac/entity-schemas.js
git commit -m "feat: add project/projects to state; add project entity schema for RBAC manager"
```

---

## Task 12: Load Projects into State

**Files:**
- Modify: `app/src/plugins/filedata.js`

- [ ] **Step 1: Find the collection-loading block in `filedata.js`**

Around line 249, there is a block that loads collections via `this.#client.getCollections()` (which calls `listCollections()`). Add a parallel projects fetch immediately after:

```js
      // Load projects from server
      let projects = [];
      try {
        projects = await this.#client.listProjects();
        this.#logger.debug(`Loaded ${projects.length} projects from server`);
      } catch (error) {
        this.#logger.error(`Failed to load projects: ${error}`);
      }
```

Then add `projects` to the `dispatchStateChange` call (around line 273):

```js
      const newState = await this.dispatchStateChange({
        fileData: data,
        collections,
        projects
      });
```

- [ ] **Step 2: Verify in browser**

Open the application, log in, and open the browser console. Run:

```js
app.getState().projects
```

Expected: array of project objects (or `[]` if no projects exist yet).

- [ ] **Step 3: Commit**

```bash
git add app/src/plugins/filedata.js
git commit -m "feat: load projects into state alongside collections"
```

---

## Task 13: Collection Selectbox — Project Headers and Project State

**Files:**
- Modify: `app/src/plugins/file-selection.js`

- [ ] **Step 1: Update `#populateCollectionSelectbox` to add project headers**

Find `#populateCollectionSelectbox` (around line 242). Replace the current loop that appends options with one that groups collections under project headers:

```js
  async #populateCollectionSelectbox(state) {
    if (!state.collections) return;

    this.#collection.innerHTML = "";

    const allOption = new SlOption();
    allOption.value = "";
    allOption.textContent = "All";
    // @ts-ignore
    allOption.size = "small";
    this.#collection.appendChild(allOption);

    const projects = state.projects || [];
    const assignedCollectionIds = new Set(
      projects.flatMap(p => p.collections || [])
    );

    // Render each project header followed by its collections
    for (const project of projects) {
      const header = new SlOption();
      header.value = `__project__${project.id}`;
      header.disabled = true;
      header.innerHTML = `<small>${project.name}</small>`;
      this.#collection.appendChild(header);

      const projectCollections = (project.collections || [])
        .map(colId => (state.collections || []).find(c => c.id === colId))
        .filter(Boolean);

      for (const collection of projectCollections) {
        const option = new SlOption();
        option.value = collection.id;
        option.textContent = collection.name;
        // @ts-ignore
        option.size = "small";
        this.#collection.appendChild(option);
      }
    }

    // Render orphan collections (not in any project) at the end
    const orphans = (state.collections || []).filter(c => !assignedCollectionIds.has(c.id));
    if (orphans.length > 0 && projects.length > 0) {
      const otherHeader = new SlOption();
      otherHeader.value = '__other__';
      otherHeader.disabled = true;
      otherHeader.innerHTML = '<small>Other</small>';
      this.#collection.appendChild(otherHeader);
    }
    for (const collection of orphans) {
      const option = new SlOption();
      option.value = collection.id;
      option.textContent = collection.name;
      // @ts-ignore
      option.size = "small";
      this.#collection.appendChild(option);
    }

    this.#isUpdatingProgrammatically = true;
    try {
      this.#collection.value = state.collectionFilter || "";
    } finally {
      this.#isUpdatingProgrammatically = false;
    }
  }
```

- [ ] **Step 2: Set `project` when a file's XML is selected**

In `file-selection.js`, around line 556, there is:

```js
await this.dispatchStateChange({ collection: file.collections[0] });
```

Replace with:

```js
const _selCollection = file.collections[0];
const _selProject = (state.projects || []).find(
  p => p.collections && p.collections.includes(_selCollection)
);
await this.dispatchStateChange({
  collection: _selCollection,
  project: _selProject ? _selProject.id : null
});
```

- [ ] **Step 3: Dispatch `project` when collection filter changes**

Find the handler that dispatches `collectionFilter` changes (around line 594). After determining the `collectionFilter`, derive the owning project and include it in the dispatch:

```js
    const collectionFilter = String(this.#collection.value);
    const collection = collectionFilter || null;
    const owningProject = (state.projects || []).find(
      p => p.collections && p.collections.includes(collectionFilter)
    );
    // ... existing logic ...
    await this.dispatchStateChange({
      collectionFilter: collection,
      project: owningProject ? owningProject.id : null
    });
```

- [ ] **Step 4: Trigger repopulate when projects change**

Find where `collections` state changes trigger `#populateCollectionSelectbox` (around line 129):

```js
if (changedKeys.includes('collections') && state.collections) {
```

Add `'projects'` to the trigger condition:

```js
if ((changedKeys.includes('collections') || changedKeys.includes('projects')) && state.collections) {
```

- [ ] **Step 5: Commit**

```bash
git add app/src/plugins/file-selection.js
git commit -m "feat: group collection selectbox by project; dispatch project on collection filter change"
```

---

## Task 14: File Selection Drawer — Projects as Parent Nodes

**Files:**
- Modify: `app/src/plugins/file-selection-drawer.js`

- [ ] **Step 1: Find the collection tree-building loop**

Around line 407, find the loop:

```js
for (const collectionName of collections) {
  const collectionItem = document.createElement('sl-tree-item');
```

This loop iterates a flat list of collection names. Replace it with a two-level loop: projects as parent nodes, collections as children.

- [ ] **Step 2: Refactor the flat loop into a project-grouped tree**

The existing rendering loop (lines 442–547) builds collection items directly into `fileTree`. Extract the collection-item building code into a private method, then use it in a two-level project → collection loop.

**2a. Extract `#buildCollectionTreeItem`** — add this private method to the class (before the existing tree-rendering method):

```js
  /**
   * Build a complete sl-tree-item for a collection, including all file children.
   * @param {string} collectionName
   * @param {ApplicationState} state
   * @param {Object} groupedFiles
   * @param {function(string): boolean} shouldExpandCollection
   * @param {function(Object): boolean} shouldExpandPdf
   * @returns {HTMLElement}
   */
  #buildCollectionTreeItem(collectionName, state, groupedFiles, shouldExpandCollection, shouldExpandPdf) {
    const collectionDisplayName = getCollectionName(collectionName, state.collections || []);
    const collectionItem = document.createElement('sl-tree-item');
    collectionItem.expanded = shouldExpandCollection(collectionName);
    collectionItem.className = 'collection-item';
    collectionItem.dataset.collection = collectionName;

    const checkbox = document.createElement('sl-checkbox');
    checkbox.size = 'small';
    checkbox.checked = this.#selectedCollections.has(collectionName);
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('sl-change', (e) => {
      e.stopPropagation();
      this.#onCollectionCheckboxChange(collectionName, checkbox.checked);
    });

    const label = document.createElement('span');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '0.5rem';
    label.innerHTML = `<sl-icon name="folder"></sl-icon><span>${collectionDisplayName}</span>`;

    collectionItem.innerHTML = '';
    collectionItem.appendChild(checkbox);
    collectionItem.appendChild(label);

    const files = (groupedFiles[collectionName] || []).sort((a, b) => {
      const aLabel = a.source?.label || a.doc_metadata?.title || a.doc_id;
      const bLabel = b.source?.label || b.doc_metadata?.title || b.doc_id;
      return (aLabel < bLabel) ? -1 : (aLabel > bLabel) ? 1 : 0;
    });

    for (const file of files) {
      let artifactsToShow = file.artifacts || [];
      if (state.variant === "none") {
        artifactsToShow = artifactsToShow.filter(a => !a.variant);
      } else if (state.variant && state.variant !== "") {
        artifactsToShow = artifactsToShow.filter(a => a.variant === state.variant);
      }
      const goldToShow = artifactsToShow.filter(a => a.is_gold_standard);
      const versionsToShow = artifactsToShow.filter(a => !a.is_gold_standard);

      const pdfItem = document.createElement('sl-tree-item');
      pdfItem.expanded = shouldExpandPdf(file);
      pdfItem.className = 'pdf-item';
      pdfItem.dataset.type = file.source?.file_type === 'pdf' ? 'pdf' : 'xml-only';
      pdfItem.dataset.hash = file.source?.id || '';
      pdfItem.dataset.collection = file.collections[0];
      const displayLabel = file.source?.label || file.doc_metadata?.title || file.doc_id;
      const icon = file.source?.file_type === 'pdf' ? 'file-pdf' : 'file-earmark-code';
      pdfItem.innerHTML = `<sl-icon name="${icon}"></sl-icon><span>${displayLabel}</span>`;

      if (goldToShow.length > 0) {
        const goldSection = document.createElement('sl-tree-item');
        goldSection.expanded = true;
        goldSection.className = 'gold-section';
        goldSection.dataset.type = 'section';
        goldSection.innerHTML = `<sl-icon name="award"></sl-icon><span>Gold</span>`;
        goldToShow.forEach(gold => {
          const variantSuffix = (!state.variant || state.variant === "") ? gold.variant ?? undefined : undefined;
          const goldItem = document.createElement('sl-tree-item');
          goldItem.className = 'gold-item';
          goldItem.dataset.type = 'gold';
          goldItem.dataset.hash = gold.id;
          goldItem.dataset.pdfHash = file.source?.id || '';
          goldItem.dataset.collection = file.collections[0];
          goldItem.innerHTML = createDocumentLabel(gold.label, gold.is_locked, variantSuffix);
          goldSection.appendChild(goldItem);
        });
        pdfItem.appendChild(goldSection);
      }

      if (versionsToShow.length > 0) {
        const versionsSection = document.createElement('sl-tree-item');
        versionsSection.expanded = false;
        versionsSection.className = 'versions-section';
        versionsSection.dataset.type = 'section';
        versionsSection.innerHTML = `<sl-icon name="file-earmark-diff"></sl-icon><span>Versions</span>`;
        versionsToShow.forEach(version => {
          const variantSuffix = (!state.variant || state.variant === "") ? version.variant ?? undefined : undefined;
          const versionItem = document.createElement('sl-tree-item');
          versionItem.className = 'version-item';
          versionItem.dataset.type = 'version';
          versionItem.dataset.hash = version.id;
          versionItem.dataset.pdfHash = file.source?.id || '';
          versionItem.dataset.collection = file.collections[0];
          versionItem.innerHTML = createDocumentLabel(version.label, version.is_locked, variantSuffix);
          versionsSection.appendChild(versionItem);
        });
        pdfItem.appendChild(versionsSection);
      }
      collectionItem.appendChild(pdfItem);
    }
    return collectionItem;
  }
```

**2b. Replace the flat rendering loop** — find the block starting `const collectionsSet = ...` (around line 402) through `fileTree.appendChild(collectionItem)` (line 546) and replace it with:

```js
    const projects = state.projects || [];
    const projectCollectionIds = new Set(projects.flatMap(p => p.collections || []));
    const collectionsWithFiles = new Set(Object.keys(groupedFiles));
    const allVisibleCollections = new Set([
      ...collectionsWithFiles,
      ...(state.collections || []).map(c => c.id)
    ]);
    const renderedCollections = new Set();

    for (const project of projects) {
      const projectCollections = (project.collections || []).filter(colId => allVisibleCollections.has(colId));
      if (projectCollections.length === 0) continue;

      const projectItem = document.createElement('sl-tree-item');
      projectItem.expanded = true;
      projectItem.className = 'project-item';
      const projectLabel = document.createElement('span');
      projectLabel.style.display = 'flex';
      projectLabel.style.alignItems = 'center';
      projectLabel.style.gap = '0.5rem';
      projectLabel.innerHTML = `<sl-icon name="folder2-open"></sl-icon><strong>${project.name}</strong>`;
      projectItem.appendChild(projectLabel);

      for (const colId of projectCollections) {
        renderedCollections.add(colId);
        projectItem.appendChild(this.#buildCollectionTreeItem(colId, state, groupedFiles, shouldExpandCollection, shouldExpandPdf));
      }
      fileTree.appendChild(projectItem);
    }

    for (const colId of allVisibleCollections) {
      if (renderedCollections.has(colId)) continue;
      fileTree.appendChild(this.#buildCollectionTreeItem(colId, state, groupedFiles, shouldExpandCollection, shouldExpandPdf));
    }
```

Delete the old flat loop lines (the `for (const collectionName of collections)` block plus the `collectionsSet` and `collections` declarations above it).

- [ ] **Step 3: Set `state.project` when user selects a collection in the drawer**

Find the `sl-selection-change` event handler (around line 115). When a collection item is selected, also dispatch `project`:

```js
    this.#drawerUi.addEventListener('sl-selection-change', (event) => {
      const selectedItem = event.detail?.selection?.[0];
      if (!selectedItem) return;
      const collectionId = selectedItem.closest('[data-collection]')?.dataset?.collection;
      if (collectionId) {
        const state = this.getState();
        const owningProject = (state.projects || []).find(
          p => p.collections && p.collections.includes(collectionId)
        );
        this.dispatchStateChange({
          collectionFilter: collectionId,
          project: owningProject ? owningProject.id : null
        });
      }
      // ... rest of existing handler ...
    });
```

- [ ] **Step 4: Commit**

```bash
git add app/src/plugins/file-selection-drawer.js
git commit -m "feat: render projects as parent nodes in file selection drawer; set project state on selection"
```

---

## Task 15: API Integration Tests for Projects

**Files:**
- Create: `tests/api/v1/projects.test.js`

- [ ] **Step 1: Create `tests/api/v1/projects.test.js`**

```js
/**
 * Projects API integration tests.
 *
 * @testCovers fastapi_app/routers/projects.py
 * @testCovers fastapi_app/lib/utils/project_utils.py
 */
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { login, authenticatedApiCall } from '../helpers/test-auth.js';
import { logger } from '../helpers/test-logger.js';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8014';

describe('Projects API', () => {
  let adminSession = null;
  let userSession = null;
  let createdProjectId = null;

  test('Setup: login as admin', async () => {
    adminSession = await login('admin', 'admin', BASE_URL);
    assert.ok(adminSession.sessionId);
  });

  test('Setup: login as regular user', async () => {
    userSession = await login('user', 'user', BASE_URL);
    assert.ok(userSession.sessionId);
  });

  test('Admin can list all projects', async () => {
    const projects = await authenticatedApiCall(adminSession.sessionId, '/projects', 'GET', null, BASE_URL);
    assert.ok(Array.isArray(projects));
    logger.success(`Admin sees ${projects.length} projects`);
  });

  test('Admin can create a project', async () => {
    const body = { id: 'test-project-api', name: 'Test Project API', description: 'Created by test', members: [], collections: [] };
    const project = await authenticatedApiCall(adminSession.sessionId, '/projects', 'POST', body, BASE_URL);
    assert.equal(project.id, 'test-project-api');
    assert.equal(project.name, 'Test Project API');
    createdProjectId = project.id;
    logger.success(`Created project: ${project.id}`);
  });

  test('Admin can get a project by ID', async () => {
    const project = await authenticatedApiCall(adminSession.sessionId, `/projects/${createdProjectId}`, 'GET', null, BASE_URL);
    assert.equal(project.id, createdProjectId);
  });

  test('Admin can update a project', async () => {
    const updated = await authenticatedApiCall(adminSession.sessionId, `/projects/${createdProjectId}`, 'PUT', { name: 'Updated Name' }, BASE_URL);
    assert.equal(updated.name, 'Updated Name');
  });

  test('Regular user does not see project they are not a member of', async () => {
    let threw = false;
    try {
      await authenticatedApiCall(userSession.sessionId, `/projects/${createdProjectId}`, 'GET', null, BASE_URL);
    } catch (e) {
      threw = true;
    }
    assert.ok(threw, 'Should return 404 for non-member');
  });

  test('Admin can set project config', async () => {
    const result = await authenticatedApiCall(
      adminSession.sessionId, `/projects/${createdProjectId}/config`, 'POST',
      { key: 'test.key', value: 'test-value' }, BASE_URL
    );
    assert.equal(result.key, 'test.key');
    assert.equal(result.value, 'test-value');
  });

  test('Admin can get project config', async () => {
    const result = await authenticatedApiCall(
      adminSession.sessionId, `/projects/${createdProjectId}/config`, 'GET', null, BASE_URL
    );
    assert.equal(result.config['test.key'], 'test-value');
  });

  test('Admin can delete project config key', async () => {
    await authenticatedApiCall(
      adminSession.sessionId, `/projects/${createdProjectId}/config/test.key`, 'DELETE', null, BASE_URL
    );
    const result = await authenticatedApiCall(
      adminSession.sessionId, `/projects/${createdProjectId}/config`, 'GET', null, BASE_URL
    );
    assert.ok(!('test.key' in result.config));
  });

  test('Admin can delete the project', async () => {
    const result = await authenticatedApiCall(
      adminSession.sessionId, `/projects/${createdProjectId}`, 'DELETE', null, BASE_URL
    );
    assert.ok(result.success);
  });

  test('Deleted project returns 404', async () => {
    let threw = false;
    try {
      await authenticatedApiCall(adminSession.sessionId, `/projects/${createdProjectId}`, 'GET', null, BASE_URL);
    } catch (e) {
      threw = true;
    }
    assert.ok(threw);
  });
});
```

- [ ] **Step 2: Run API tests (requires running server)**

```bash
E2E_BASE_URL=http://127.0.0.1:8014 node --test tests/api/v1/projects.test.js 2>&1
```

Expected: all tests pass. If any fail, inspect the server log and fix the router accordingly.

- [ ] **Step 3: Commit**

```bash
git add tests/api/v1/projects.test.js
git commit -m "test: add API integration tests for projects CRUD and config routes"
```

---

## Task 16: Final Verification and Cleanup

- [ ] **Step 1: Run all Python unit tests**

```bash
uv run python -m pytest tests/unit/fastapi/ -v --tb=short 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 2: Check for any remaining `collection_config_get` calls that should use project config**

```bash
grep -rn "collection_config_get\b" fastapi_app/routers/ --include="*.py"
```

Any remaining calls in files not already updated in Tasks 8-9 should be reviewed. Replace with `project_config_get` using the same pattern.

- [ ] **Step 3: Check for DEBUG log statements left in**

```bash
grep -rn "DEBUG" app/src/ fastapi_app/ --include="*.py" --include="*.js" | grep -v ".pyc" | grep -v "node_modules"
```

Remove any temporary DEBUG log lines added during development.

- [ ] **Step 4: Final commit**

```bash
git add -u
git commit -m "feat: projects feature complete (#385) — project-based access control and config overrides"
```
