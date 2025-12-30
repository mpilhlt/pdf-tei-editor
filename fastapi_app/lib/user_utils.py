"""User management utilities for PDF-TEI-Editor."""

import hashlib
from pathlib import Path
from typing import List, Optional, Dict, Any
from .role_utils import validate_role
from .data_utils import load_entity_data, save_entity_data


def find_user(username: str, users_data: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Finds a user by username.

    Args:
        username: The username to search for
        users_data: List of user dictionaries

    Returns:
        User dictionary if found, None otherwise
    """
    for user in users_data:
        if user.get('username') == username:
            return user
    return None


def user_exists(username: str, users_data: List[Dict[str, Any]]) -> bool:
    """Checks if a user exists.

    Args:
        username: The username to check
        users_data: List of user dictionaries

    Returns:
        True if user exists, False otherwise
    """
    return find_user(username, users_data) is not None


def hash_password(password: str) -> str:
    """Hashes a password using SHA256.

    Args:
        password: The password to hash

    Returns:
        The hashed password
    """
    return hashlib.sha256(password.encode('utf-8')).hexdigest()


def create_user(username: str, password: str, fullname: str = "", email: str = "",
               roles: Optional[List[str]] = None, groups: Optional[List[str]] = None) -> Dict[str, Any]:
    """Creates a new user dictionary.

    Args:
        username: The username
        password: The password (will be hashed)
        fullname: The full name (optional)
        email: The email address (optional)
        roles: List of roles (defaults to ["user"])
        groups: List of groups (defaults to [])

    Returns:
        User dictionary
    """
    if roles is None:
        roles = ["user"]
    if groups is None:
        groups = []

    return {
        "username": username,
        "fullname": fullname,
        "email": email,
        "roles": roles,
        "groups": groups,
        "passwd_hash": hash_password(password),
        "session_id": None
    }


def add_user(db_dir: Path, username: str, password: str, fullname: str = "",
            email: str = "") -> tuple[bool, str]:
    """Adds a new user to the users.json file.

    Args:
        db_dir: Path to the db directory
        username: The username
        password: The password
        fullname: The full name (optional)
        email: The email address (optional)

    Returns:
        Tuple of (success: bool, message: str)
    """
    users_data = load_entity_data(db_dir, 'users')

    # Check if user already exists
    if user_exists(username, users_data):
        return False, f"User '{username}' already exists."

    # Add new user
    new_user = create_user(username, password, fullname, email)
    users_data.append(new_user)

    save_entity_data(db_dir, 'users', users_data)
    return True, f"User '{username}' added successfully."


def remove_user(db_dir: Path, username: str) -> tuple[bool, str]:
    """Removes a user from the users.json file.

    Args:
        db_dir: Path to the db directory
        username: The username to remove

    Returns:
        Tuple of (success: bool, message: str)
    """
    users_data = load_entity_data(db_dir, 'users')

    if not user_exists(username, users_data):
        return False, f"User '{username}' not found."

    users_data = [user for user in users_data if user.get('username') != username]
    save_entity_data(db_dir, 'users', users_data)
    return True, f"User '{username}' removed successfully."


def update_user_password(db_dir: Path, username: str, password: str) -> tuple[bool, str]:
    """Updates a user's password.

    Args:
        db_dir: Path to the db directory
        username: The username
        password: The new password

    Returns:
        Tuple of (success: bool, message: str)
    """
    users_data = load_entity_data(db_dir, 'users')

    user = find_user(username, users_data)
    if not user:
        return False, f"User '{username}' not found."

    user['passwd_hash'] = hash_password(password)
    save_entity_data(db_dir, 'users', users_data)
    return True, f"Password for user '{username}' updated successfully."


def add_role_to_user(db_dir: Path, username: str, role_name: str) -> tuple[bool, str]:
    """Adds a role to a user.

    Args:
        db_dir: Path to the db directory
        username: The username
        role_name: The role to add

    Returns:
        Tuple of (success: bool, message: str)
    """
    # Validate role exists
    if not validate_role(role_name, db_dir):
        return False, f"Role '{role_name}' is not a valid role."

    users_data = load_entity_data(db_dir, 'users')

    user = find_user(username, users_data)
    if not user:
        return False, f"User '{username}' not found."

    if role_name not in user['roles']:
        user['roles'].append(role_name)
        save_entity_data(db_dir, 'users', users_data)
        return True, f"Role '{role_name}' added to user '{username}'."
    else:
        return False, f"User '{username}' already has the role '{role_name}'."


def remove_role_from_user(db_dir: Path, username: str, role_name: str) -> tuple[bool, str]:
    """Removes a role from a user.

    Args:
        db_dir: Path to the db directory
        username: The username
        role_name: The role to remove

    Returns:
        Tuple of (success: bool, message: str)
    """
    # Validate role exists
    if not validate_role(role_name, db_dir):
        return False, f"Role '{role_name}' is not a valid role."

    users_data = load_entity_data(db_dir, 'users')

    user = find_user(username, users_data)
    if not user:
        return False, f"User '{username}' not found."

    if role_name in user['roles']:
        user['roles'].remove(role_name)
        save_entity_data(db_dir, 'users', users_data)
        return True, f"Role '{role_name}' removed from user '{username}'."
    else:
        return False, f"User '{username}' does not have the role '{role_name}'."


def add_group_to_user(db_dir: Path, username: str, group_id: str) -> tuple[bool, str]:
    """Adds a group to a user.

    Args:
        db_dir: Path to the db directory
        username: The username
        group_id: The group ID to add

    Returns:
        Tuple of (success: bool, message: str)
    """
    from .group_utils import validate_group

    # Validate group exists
    if not validate_group(group_id, db_dir):
        return False, f"Group '{group_id}' is not a valid group."

    users_data = load_entity_data(db_dir, 'users')

    user = find_user(username, users_data)
    if not user:
        return False, f"User '{username}' not found."

    # Ensure groups field exists
    if 'groups' not in user:
        user['groups'] = []

    if group_id not in user['groups']:
        user['groups'].append(group_id)
        save_entity_data(db_dir, 'users', users_data)
        return True, f"Group '{group_id}' added to user '{username}'."
    else:
        return False, f"User '{username}' already belongs to group '{group_id}'."


def remove_group_from_user(db_dir: Path, username: str, group_id: str) -> tuple[bool, str]:
    """Removes a group from a user.

    Args:
        db_dir: Path to the db directory
        username: The username
        group_id: The group ID to remove

    Returns:
        Tuple of (success: bool, message: str)
    """
    from .group_utils import validate_group

    # Validate group exists
    if not validate_group(group_id, db_dir):
        return False, f"Group '{group_id}' is not a valid group."

    users_data = load_entity_data(db_dir, 'users')

    user = find_user(username, users_data)
    if not user:
        return False, f"User '{username}' not found."

    # Ensure groups field exists
    if 'groups' not in user:
        user['groups'] = []

    if group_id in user['groups']:
        user['groups'].remove(group_id)
        save_entity_data(db_dir, 'users', users_data)
        return True, f"Group '{group_id}' removed from user '{username}'."
    else:
        return False, f"User '{username}' does not belong to group '{group_id}'."


def set_user_property(db_dir: Path, username: str, property_name: str,
                     value: str) -> tuple[bool, str]:
    """Sets a scalar, unencrypted property for a user.

    Args:
        db_dir: Path to the db directory
        username: The username
        property_name: The property to set
        value: The new value

    Returns:
        Tuple of (success: bool, message: str)
    """
    users_data = load_entity_data(db_dir, 'users')

    # Check for username conflicts if changing username
    if property_name == 'username':
        if user_exists(value, users_data):
            return False, f"User with username '{value}' already exists."

    user = find_user(username, users_data)
    if not user:
        return False, f"User '{username}' not found."

    user[property_name] = value
    save_entity_data(db_dir, 'users', users_data)

    if property_name == 'username':
        return True, f"User '{username}' is now '{value}'."
    else:
        return True, f"Property '{property_name}' for user '{username}' set to '{value}'."


def list_users(db_dir: Path) -> List[Dict[str, Any]]:
    """Lists all users.

    Args:
        db_dir: Path to the db directory

    Returns:
        List of user dictionaries
    """
    return load_entity_data(db_dir, 'users')


def get_user_collections(user: Optional[Dict[str, Any]], db_dir: Path) -> Optional[List[str]]:
    """Gets all collections accessible to a user based on their group memberships.

    Args:
        user: User dictionary (from authentication), or None for anonymous
        db_dir: Path to the db directory

    Returns:
        List of collection IDs accessible to the user, or None if user has access to all collections.
        Returns empty list for anonymous users or users with no groups.
    """
    if not user:
        # Anonymous users have no collection access
        return []

    # Check for wildcard roles
    user_roles = user.get('roles', [])
    if '*' in user_roles:
        return None  # None means access to all collections

    # Check for wildcard groups
    user_groups = user.get('groups', [])
    if '*' in user_groups:
        return None  # Access to all collections

    # Collect all collections from user's groups
    from .group_utils import find_group, load_entity_data as load_groups_data

    groups_data = load_groups_data(db_dir, 'groups')
    accessible_collections = set()

    for group_id in user_groups:
        group = find_group(group_id, groups_data)
        if group:
            group_collections = group.get('collections', [])
            # Check for wildcard in group collections
            if '*' in group_collections:
                return None  # This group has access to all collections
            accessible_collections.update(group_collections)

    return list(accessible_collections)


def user_has_collection_access(user: Optional[Dict[str, Any]], collection_id: str, db_dir: Path) -> bool:
    """Checks if a user has access to a specific collection.

    Args:
        user: User dictionary (from authentication), or None for anonymous
        collection_id: The collection ID to check
        db_dir: Path to the db directory

    Returns:
        True if user has access to the collection, False otherwise
    """
    accessible_collections = get_user_collections(user, db_dir)

    # None means access to all collections
    if accessible_collections is None:
        return True

    # Check if collection is in the accessible list
    return collection_id in accessible_collections
