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
