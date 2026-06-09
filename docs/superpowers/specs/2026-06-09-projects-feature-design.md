# Projects Feature Design

**Issue:** #385 — Introduce project-based workflow
**Branch:** `feature/projects`
**Date:** 2026-06-09

## Summary

Introduces a "project" entity as the primary access-control and configuration unit, replacing the role that groups currently play in granting collection access. Groups are retained as optional user-organization labels but no longer determine collection visibility.

## Data Model

New file: `data/db/projects.json`

```json
[
  {
    "id": "default-project",
    "name": "Default Project",
    "description": "",
    "members": ["alice", "bob"],
    "collections": ["_inbox", "default"],
    "config": {}
  }
]
```

- `members` — list of usernames with access to this project
- `collections` — list of collection IDs included in the project
- `config` — per-project config overrides (same key/value structure as global `config.json`)

Groups retain their current structure in `groups.json`. Their `collections[]` field is ignored by the access-control layer going forward.

Access resolution: a user's accessible collections = union of `collections[]` across all projects where the username appears in `members[]`. Admin users (`*` role) retain wildcard access.

## Backend

### `fastapi_app/lib/utils/project_utils.py`

New library module mirroring `group_utils.py`:

- `find_project(project_id, projects_data)` → `dict | None`
- `project_exists(project_id, projects_data)` → `bool`
- `create_project(id, name, description, members, collections)` → `dict`
- `get_projects_with_details(db_dir)` → `list[dict]`
- `add_member_to_project(db_dir, project_id, username)` → `tuple[bool, str]`
- `remove_member_from_project(db_dir, project_id, username)` → `tuple[bool, str]`
- `get_user_projects(user, db_dir)` → `list[dict]` — projects the user is a member of
- `get_project_for_collection(collection_id, db_dir)` → `dict | None` — first project that includes this collection
- `project_config_get(db_dir, project_id, key, use_default, default)` → `Any` — returns project override or falls back to global config
- `project_config_get_all(db_dir, project_id)` → `dict[str, Any]`
- `project_config_set(db_dir, project_id, key, value)` → `tuple[bool, str]`
- `project_config_delete(db_dir, project_id, key)` → `tuple[bool, str]`

### `fastapi_app/routers/projects.py`

CRUD routes following the same pattern as `groups.py` and `collections.py`:

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/api/v1/projects` | authenticated | List projects visible to user (admin: all; regular: member-of only) |
| `GET` | `/api/v1/projects/{project_id}` | authenticated | Get project detail |
| `POST` | `/api/v1/projects` | admin | Create project |
| `PUT` | `/api/v1/projects/{project_id}` | admin | Update project |
| `DELETE` | `/api/v1/projects/{project_id}` | admin | Delete project |
| `GET` | `/api/v1/projects/{project_id}/config` | admin | List project config overrides |
| `POST` | `/api/v1/projects/{project_id}/config` | admin | Set config override |
| `DELETE` | `/api/v1/projects/{project_id}/config/{key}` | admin | Delete config override |

Pydantic models: `Project`, `ProjectsListResponse`, `CreateProjectRequest`, `UpdateProjectRequest`, `ProjectConfigItem`, `ProjectConfigResponse` — mirroring the collection equivalents.

### `fastapi_app/lib/permissions/user_utils.py`

`get_user_collections(user, db_dir)` updated: iterates projects (not groups) and collects collections from all projects where the user appears in `members[]`. Returns `None` for admin/wildcard users unchanged.

### #384 Route Updates

Four endpoints updated to resolve config via project instead of collection:

| Endpoint | Config source |
| --- | --- |
| `POST /files/upload` | `get_project_for_collection(collection_id)` → project config |
| `POST /extract` | `get_project_for_collection(doc_collections[0])` → project config |
| `GET /validation` | `?project=` optional query param → project config |
| `POST /files/repopulate` | `?project=` optional query param → project config |

The `?collection=` parameter on `/config/list` is replaced by `?project=`. The frontend `config.js` plugin, which calls `/config/list` with the current collection param, must be updated to pass `?project=` using the `state.project` value instead. Internally, `project_config_get` is used with `use_default=True` so it falls back to global config when no project override exists.

### Migration

`fastapi_app/lib/core/migrations/versions/m003_groups_to_projects.py`:

1. Read `groups.json`
2. For each group: create a project entry with the same `id`, `name`, `description`, and `collections[]`
3. Determine members: scan `users.json` and collect all users whose `groups[]` contains this group ID
4. Write `projects.json` (creates file if absent)
5. Leave `groups.json` and `users.json` unchanged

The migration is idempotent: if a project with that ID already exists, it is skipped.

## Frontend

### RBAC Manager — `app/src/modules/rbac/entity-schemas.js`

New `project` entity schema added before `group`:

```js
project: {
  label: 'Projects',
  singularLabel: 'Project',
  idField: 'id',
  icon: 'folder2-open',
  fields: [
    { name: 'id', type: 'string', label: 'ID', required: true, immutable: true,
      placeholder: 'project-id', helpText: 'Unique project identifier' },
    { name: 'name', type: 'string', label: 'Name', required: true },
    { name: 'description', type: 'textarea', label: 'Description' },
    { name: 'members', type: 'multiselect', label: 'Members', options: 'user',
      helpText: 'Users with access to this project' },
    { name: 'collections', type: 'multiselect', label: 'Collections', options: 'collection',
      helpText: 'Collections included in this project' }
  ],
  relationships: [
    { target: 'user', field: 'members', type: 'many-to-many' },
    { target: 'collection', field: 'collections', type: 'many-to-many' }
  ]
}
```

The `group` schema retains its `collections` field with a `helpText` note that collection access is now managed via projects. Tab order in the RBAC manager places Projects before Groups.

Config overrides on a project are managed via the existing config-editor dialog, not the entity form.

### Application State — `app/src/state.js`

New typedef:

```js
/**
 * @typedef {object} ProjectInfo
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string[]} collections
 */
```

New properties on `ApplicationState`:

- `project: string|null` — ID of the project that owns the currently selected collection; `null` if none
- `projects: ProjectInfo[]|null` — all projects accessible to the current user

Added to `initialState` with `null` values.

### File Selection Drawer — `app/src/plugins/file-selection-drawer.js`

The tree rendering loop gains a project parent level:

- Top-level `sl-tree-item` nodes = projects (expanded by default), rendered from `state.projects`
- Each project node's children = its collections (existing collection rendering logic, unchanged)
- Collections not owned by any project render at the top level (admin edge case)

When a user selects a collection in the drawer, the plugin sets both `state.collection` and `state.project` (looked up from `state.projects` by matching the collection ID against each project's `collections[]`).

The "New Collection" button is unchanged — collections are created independently and assigned to projects via the RBAC manager.

### Collection Selectbox

Project names are injected as non-selectable group headers using a disabled `<sl-option>` containing a `<small>` element, one per project, preceding that project's collection options. Collections not belonging to any project appear at the end of the list.

## Error Handling

- `GET /projects` for a non-admin returns only projects where the user is a member (not 403)
- `GET /projects/{id}` for a project the user is not a member of returns 404 (avoids leaking project existence)
- Migration skips groups that already have a matching project ID

## Testing

- Unit tests for `project_utils.py`: CRUD operations, member management, `get_user_projects`, `get_project_for_collection`, config get/set/delete
- Integration tests for all `/projects` routes: list (filtered by membership), create, update, delete, config endpoints
- Updated tests for `get_user_collections` verifying project-based resolution
- Updated tests for the four #384 endpoints verifying project config lookup
- Migration test: given a `groups.json` and `users.json`, verify `projects.json` is created correctly
