"""
Renaming the ids of users, projects and collections.

Each function replaces the id in every application data store that refers to it and returns the number
of changed records per store. TEI documents are not changed: their `respStmt`, `@who` and comment
authors keep the id that was current when they were written.

The routers emit `user.renamed`, `project.renamed` and `collection.renamed` events (payload `old_id`,
`new_id`) afterwards, so that plugins can update ids in their own stores.
"""

import re
from pathlib import Path
from typing import Optional

from fastapi_app.lib.core.sessions import SessionManager
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.repository.permissions_db import PermissionsDB, rename_document_owner
from fastapi_app.lib.utils.config_utils import get_config
from fastapi_app.lib.utils.data_utils import load_entity_data, save_entity_data

USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
"""Allowed characters of a new username."""

ENTITY_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")
"""Allowed characters of a new project or collection id."""

DEFAULT_PROJECT_CONFIG_KEY = "rbac.default-project"


class RenameError(ValueError):
    """The rename was refused; `status_code` is the HTTP status the router responds with."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _check_new_id(old_id: str, new_id: str, pattern: re.Pattern[str], existing_ids: set[str], label: str) -> None:
    """Raise a RenameError if the entity does not exist or the new id is invalid or taken."""
    if old_id not in existing_ids:
        raise RenameError(f"{label} '{old_id}' not found", status_code=404)
    if new_id == old_id:
        raise RenameError(f"The new id of {label.lower()} '{old_id}' is the same as the current one")
    if not pattern.match(new_id):
        allowed = "letters, numbers, dots, hyphens and underscores" if pattern is USERNAME_PATTERN else "letters, numbers, hyphens and underscores"
        raise RenameError(f"Invalid id '{new_id}'. Only {allowed} are allowed.")
    if new_id in existing_ids:
        raise RenameError(f"{label} '{new_id}' already exists", status_code=409)


def _replace_in_list(values: list[str], old_id: str, new_id: str) -> bool:
    """Replace an id in a list in place, without creating duplicates; return whether the list changed."""
    if old_id not in values:
        return False
    replaced: list[str] = []
    for value in values:
        renamed = new_id if value == old_id else value
        if renamed not in replaced:
            replaced.append(renamed)
    values[:] = replaced
    return True


def get_existing_permissions_db(db_dir: Path) -> Optional[PermissionsDB]:
    """The database of document permissions, or None if it was never created (no granular access control)."""
    db_path = db_dir / "permissions.db"
    return PermissionsDB(db_path) if db_path.exists() else None


def rename_user(
    db_dir: Path,
    old_username: str,
    new_username: str,
    file_repo: FileRepository,
    session_manager: SessionManager,
    permissions_db: Optional[PermissionsDB],
) -> dict[str, int]:
    """
    Rename a user and replace the username in all application data stores.

    Changes users.json, project members, collection owners, file creators, document permissions,
    sessions (the user stays logged in), access tokens, user secrets, bookmarks and messages.

    Args:
        db_dir: Path to the db directory
        old_username: The current username
        new_username: The new username
        file_repo: Repository of the file metadata
        session_manager: Session manager
        permissions_db: Database of document permissions, or None if it does not exist

    Returns:
        Number of changed records per store

    Raises:
        RenameError: If the user does not exist or the new username is invalid or taken
    """
    from fastapi_app.lib.bookmarks.store import get_bookmark_store
    from fastapi_app.lib.core.access_tokens import get_access_token_store
    from fastapi_app.lib.messages.service import get_message_store
    from fastapi_app.lib.secrets.store import get_secret_store

    users = load_entity_data(db_dir, "users")
    _check_new_id(old_username, new_username, USERNAME_PATTERN, {u.get("username", "") for u in users}, "User")

    changes: dict[str, int] = {}
    for user in users:
        if user.get("username") == old_username:
            user["username"] = new_username
    save_entity_data(db_dir, "users", users)
    changes["users"] = 1

    projects = load_entity_data(db_dir, "projects")
    changes["project_members"] = sum(_replace_in_list(p.setdefault("members", []), old_username, new_username) for p in projects)
    if changes["project_members"]:
        save_entity_data(db_dir, "projects", projects)

    collections = load_entity_data(db_dir, "collections")
    changes["collection_owners"] = 0
    for collection in collections:
        if collection.get("owner") == old_username:
            collection["owner"] = new_username
            changes["collection_owners"] += 1
    if changes["collection_owners"]:
        save_entity_data(db_dir, "collections", collections)

    changes["files"] = file_repo.rename_created_by(old_username, new_username)
    changes["document_permissions"] = rename_document_owner(old_username, new_username, permissions_db) if permissions_db else 0
    changes["sessions"] = session_manager.rename_user(old_username, new_username)
    changes["access_tokens"] = get_access_token_store().rename_user(old_username, new_username)
    changes["secrets"] = get_secret_store().rename_user(old_username, new_username)
    changes["bookmarks"] = get_bookmark_store(db_dir).rename_user(old_username, new_username)
    changes["messages"] = get_message_store(db_dir).rename_user(old_username, new_username)
    return changes


def rename_project(db_dir: Path, old_project_id: str, new_project_id: str) -> dict[str, int]:
    """
    Rename a project, including the `rbac.default-project` configuration if it refers to it.

    Project config overrides are stored with the project and move with it.

    Args:
        db_dir: Path to the db directory
        old_project_id: The current project id
        new_project_id: The new project id

    Returns:
        Number of changed records per store

    Raises:
        RenameError: If the project does not exist or the new id is invalid or taken
    """
    projects = load_entity_data(db_dir, "projects")
    _check_new_id(old_project_id, new_project_id, ENTITY_ID_PATTERN, {p.get("id", "") for p in projects}, "Project")

    for project in projects:
        if project.get("id") == old_project_id:
            project["id"] = new_project_id
    save_entity_data(db_dir, "projects", projects)

    changes: dict[str, int] = {"projects": 1, "config": 0}
    config = get_config()
    if config.get(DEFAULT_PROJECT_CONFIG_KEY, default=None) == old_project_id:
        ok, message = config.set(DEFAULT_PROJECT_CONFIG_KEY, new_project_id)
        if not ok:
            raise RenameError(f"Project renamed, but '{DEFAULT_PROJECT_CONFIG_KEY}' could not be updated: {message}", status_code=500)
        changes["config"] = 1
    return changes


def rename_collection(db_dir: Path, old_collection_id: str, new_collection_id: str, file_repo: FileRepository) -> dict[str, int]:
    """
    Rename a collection and replace its id in projects, groups and the collections of all files.

    Args:
        db_dir: Path to the db directory
        old_collection_id: The current collection id
        new_collection_id: The new collection id
        file_repo: Repository of the file metadata

    Returns:
        Number of changed records per store

    Raises:
        RenameError: If the collection does not exist or the new id is invalid or taken
    """
    collections = load_entity_data(db_dir, "collections")
    _check_new_id(old_collection_id, new_collection_id, ENTITY_ID_PATTERN, {c.get("id", "") for c in collections}, "Collection")

    for collection in collections:
        if collection.get("id") == old_collection_id:
            collection["id"] = new_collection_id
    save_entity_data(db_dir, "collections", collections)

    changes: dict[str, int] = {"collections": 1}
    for entity_type in ("projects", "groups"):
        entities = load_entity_data(db_dir, entity_type)
        changes[entity_type] = sum(
            _replace_in_list(e.setdefault("collections", []), old_collection_id, new_collection_id) for e in entities
        )
        if changes[entity_type]:
            save_entity_data(db_dir, entity_type, entities)

    changes["files"] = file_repo.rename_collection(old_collection_id, new_collection_id)
    return changes
