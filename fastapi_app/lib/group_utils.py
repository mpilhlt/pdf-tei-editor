"""Group management utilities for PDF-TEI-Editor."""

from pathlib import Path
from typing import List, Optional, Dict, Any
from .data_utils import load_entity_data, save_entity_data, get_data_file_path, load_json_file


def find_group(group_id: str, groups_data: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Finds a group by ID.

    Args:
        group_id: The group ID to search for
        groups_data: List of group dictionaries

    Returns:
        Group dictionary if found, None otherwise
    """
    for group in groups_data:
        if group.get('id') == group_id:
            return group
    return None


def group_exists(group_id: str, groups_data: List[Dict[str, Any]]) -> bool:
    """Checks if a group exists.

    Args:
        group_id: The group ID to check
        groups_data: List of group dictionaries

    Returns:
        True if group exists, False otherwise
    """
    return find_group(group_id, groups_data) is not None


def get_available_groups(db_dir: Path) -> Optional[List[str]]:
    """Gets the list of available groups from db/groups.json.

    Args:
        db_dir: Path to the db directory

    Returns:
        List of group IDs if successful, None if error
    """
    groups_file = get_data_file_path(db_dir, 'groups')

    if not groups_file.exists():
        raise FileNotFoundError(f"Groups file not found at {groups_file}")

    groups_data = load_json_file(groups_file, create_if_missing=False)

    if not isinstance(groups_data, list):
        raise ValueError("Invalid groups file format. Expected a list.")

    group_ids = [group.get('id') for group in groups_data if isinstance(group, dict) and 'id' in group]
    return group_ids


def get_groups_with_details(db_dir: Path) -> Optional[List[Dict[str, Any]]]:
    """Gets all groups with their details from db/groups.json.

    Args:
        db_dir: Path to the db directory

    Returns:
        List of group dictionaries if successful, None if error
    """
    groups_file = get_data_file_path(db_dir, 'groups')

    if not groups_file.exists():
        raise FileNotFoundError(f"Groups file not found at {groups_file}")

    groups_data = load_json_file(groups_file, create_if_missing=False)

    if not isinstance(groups_data, list):
        raise ValueError("Invalid groups file format. Expected a list.")

    return groups_data


def validate_group(group_id: str, db_dir: Path) -> bool:
    """Validates if a group exists in the available groups.

    Args:
        group_id: The group ID to validate
        db_dir: Path to the db directory

    Returns:
        True if group exists, False otherwise
    """
    try:
        available_groups = get_available_groups(db_dir)
        return group_id in available_groups if available_groups else False
    except (FileNotFoundError, ValueError):
        return False


def add_group(db_dir: Path, group_id: str, name: str, description: str = "") -> tuple[bool, str]:
    """Adds a new group to the groups.json file.

    Args:
        db_dir: Path to the db directory
        group_id: The group ID
        name: The group name
        description: The group description (optional)

    Returns:
        Tuple of (success: bool, message: str)
    """
    groups_data = load_entity_data(db_dir, 'groups')

    # Check if group already exists
    if group_exists(group_id, groups_data):
        return False, f"Group '{group_id}' already exists."

    # Add new group
    new_group = {
        "id": group_id,
        "name": name,
        "description": description,
        "collections": []
    }
    groups_data.append(new_group)

    save_entity_data(db_dir, 'groups', groups_data)
    return True, f"Group '{group_id}' added successfully."


def remove_group(db_dir: Path, group_id: str) -> tuple[bool, str]:
    """Removes a group from the groups.json file.

    Args:
        db_dir: Path to the db directory
        group_id: The group ID to remove

    Returns:
        Tuple of (success: bool, message: str)
    """
    groups_data = load_entity_data(db_dir, 'groups')

    if not group_exists(group_id, groups_data):
        return False, f"Group '{group_id}' not found."

    groups_data = [group for group in groups_data if group.get('id') != group_id]
    save_entity_data(db_dir, 'groups', groups_data)
    return True, f"Group '{group_id}' removed successfully."


def set_group_property(db_dir: Path, group_id: str, property_name: str, value: str) -> tuple[bool, str]:
    """Sets a property for a group.

    Args:
        db_dir: Path to the db directory
        group_id: The group ID
        property_name: The property to set (name, description)
        value: The new value

    Returns:
        Tuple of (success: bool, message: str)
    """
    groups_data = load_entity_data(db_dir, 'groups')

    # Check for ID conflicts if changing ID
    if property_name == 'id':
        if group_exists(value, groups_data):
            return False, f"Group with ID '{value}' already exists."

    group = find_group(group_id, groups_data)
    if not group:
        return False, f"Group '{group_id}' not found."

    group[property_name] = value
    save_entity_data(db_dir, 'groups', groups_data)

    if property_name == 'id':
        return True, f"Group '{group_id}' is now '{value}'."
    else:
        return True, f"Property '{property_name}' for group '{group_id}' set to '{value}'."


def add_collection_to_group(db_dir: Path, group_id: str, collection_id: str) -> tuple[bool, str]:
    """Adds a collection to a group.

    Args:
        db_dir: Path to the db directory
        group_id: The group ID
        collection_id: The collection ID to add (can be '*' for wildcard access)

    Returns:
        Tuple of (success: bool, message: str)
    """
    from .collection_utils import validate_collection

    # Validate collection exists (skip validation for wildcard)
    if collection_id != '*' and not validate_collection(collection_id, db_dir):
        return False, f"Collection '{collection_id}' is not a valid collection."

    groups_data = load_entity_data(db_dir, 'groups')

    group = find_group(group_id, groups_data)
    if not group:
        return False, f"Group '{group_id}' not found."

    # Ensure collections field exists
    if 'collections' not in group:
        group['collections'] = []

    if collection_id not in group['collections']:
        group['collections'].append(collection_id)
        save_entity_data(db_dir, 'groups', groups_data)
        return True, f"Collection '{collection_id}' added to group '{group_id}'."
    else:
        return False, f"Group '{group_id}' already has collection '{collection_id}'."


def remove_collection_from_group(db_dir: Path, group_id: str, collection_id: str) -> tuple[bool, str]:
    """Removes a collection from a group.

    Args:
        db_dir: Path to the db directory
        group_id: The group ID
        collection_id: The collection ID to remove (can be '*' for wildcard)

    Returns:
        Tuple of (success: bool, message: str)
    """
    from .collection_utils import validate_collection

    # Validate collection exists (skip validation for wildcard)
    if collection_id != '*' and not validate_collection(collection_id, db_dir):
        return False, f"Collection '{collection_id}' is not a valid collection."

    groups_data = load_entity_data(db_dir, 'groups')

    group = find_group(group_id, groups_data)
    if not group:
        return False, f"Group '{group_id}' not found."

    # Ensure collections field exists
    if 'collections' not in group:
        group['collections'] = []

    if collection_id in group['collections']:
        group['collections'].remove(collection_id)
        save_entity_data(db_dir, 'groups', groups_data)
        return True, f"Collection '{collection_id}' removed from group '{group_id}'."
    else:
        return False, f"Group '{group_id}' does not have collection '{collection_id}'."


def list_groups(db_dir: Path) -> List[Dict[str, Any]]:
    """Lists all groups.

    Args:
        db_dir: Path to the db directory

    Returns:
        List of group dictionaries
    """
    return load_entity_data(db_dir, 'groups')
