"""Role management utilities for PDF-TEI-Editor."""

from pathlib import Path
from typing import List, Optional, Dict, Any
from .data_utils import get_data_file_path, load_json_file, load_entity_data


def get_available_roles(db_dir: Path) -> Optional[List[str]]:
    """Gets the list of available roles from db/roles.json.

    Args:
        db_dir: Path to the db directory

    Returns:
        List of role IDs if successful, None if error
    """
    roles_file = get_data_file_path(db_dir, 'roles')

    if not roles_file.exists():
        raise FileNotFoundError(f"Roles file not found at {roles_file}")

    roles_data = load_json_file(roles_file, create_if_missing=False)

    if not isinstance(roles_data, list):
        raise ValueError("Invalid roles file format. Expected a list.")

    role_ids = [role.get('id') for role in roles_data if isinstance(role, dict) and 'id' in role]
    return role_ids


def get_roles_with_details(db_dir: Path) -> Optional[List[Dict[str, Any]]]:
    """Gets all roles with their details from db/roles.json.

    Args:
        db_dir: Path to the db directory

    Returns:
        List of role dictionaries if successful, None if error
    """
    roles_file = get_data_file_path(db_dir, 'roles')

    if not roles_file.exists():
        raise FileNotFoundError(f"Roles file not found at {roles_file}")

    roles_data = load_json_file(roles_file, create_if_missing=False)

    if not isinstance(roles_data, list):
        raise ValueError("Invalid roles file format. Expected a list.")

    return roles_data


def validate_role(role_id: str, db_dir: Path) -> bool:
    """Validates if a role exists in the available roles.

    Args:
        role_id: The role ID to validate
        db_dir: Path to the db directory

    Returns:
        True if role exists, False otherwise
    """
    try:
        available_roles = get_available_roles(db_dir)
        return role_id in available_roles if available_roles else False
    except (FileNotFoundError, ValueError):
        return False


def get_role_details(role_id: str, db_dir: Path) -> Optional[Dict[str, Any]]:
    """Gets details for a specific role.

    Args:
        role_id: The role ID to look up
        db_dir: Path to the db directory

    Returns:
        Role dictionary if found, None otherwise
    """
    try:
        roles = get_roles_with_details(db_dir)
        if roles:
            for role in roles:
                if isinstance(role, dict) and role.get('id') == role_id:
                    return role
        return None
    except (FileNotFoundError, ValueError):
        return None


def find_role(role_id: str, roles_data: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Finds a role by ID.

    Args:
        role_id: The role ID to search for
        roles_data: List of role dictionaries

    Returns:
        Role dictionary if found, None otherwise
    """
    for role in roles_data:
        if role.get('id') == role_id:
            return role
    return None


def role_exists(role_id: str, roles_data: List[Dict[str, Any]]) -> bool:
    """Checks if a role exists.

    Args:
        role_id: The role ID to check
        roles_data: List of role dictionaries

    Returns:
        True if role exists, False otherwise
    """
    return find_role(role_id, roles_data) is not None


def create_role(role_id: str, role_name: str, description: str = "") -> Dict[str, Any]:
    """Creates a new role dictionary.

    Args:
        role_id: The role ID
        role_name: The role display name
        description: The role description (optional)

    Returns:
        Role dictionary
    """
    return {
        "id": role_id,
        "roleName": role_name,
        "description": description
    }
