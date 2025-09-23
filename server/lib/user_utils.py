"""User management utilities for PDF-TEI-Editor."""

import hashlib
from pathlib import Path
from typing import List, Optional, Dict, Any
from .role_utils import validate_role
from .data_utils import load_json_file, save_json_file


def get_users_data(users_file: Path) -> List[Dict[str, Any]]:
    """Gets user data from users.json file, creating it if it doesn't exist.

    Args:
        users_file: Path to the users.json file

    Returns:
        List of user dictionaries
    """
    data = load_json_file(users_file, create_if_missing=True, default_content=[])
    return data if data is not None else []


def save_users_data(users_file: Path, data: List[Dict[str, Any]]) -> None:
    """Saves user data to users.json file.

    Args:
        users_file: Path to the users.json file
        data: List of user dictionaries to save
    """
    save_json_file(users_file, data)


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
               roles: Optional[List[str]] = None) -> Dict[str, Any]:
    """Creates a new user dictionary.

    Args:
        username: The username
        password: The password (will be hashed)
        fullname: The full name (optional)
        email: The email address (optional)
        roles: List of roles (defaults to ["user"])

    Returns:
        User dictionary
    """
    if roles is None:
        roles = ["user"]

    return {
        "username": username,
        "fullname": fullname,
        "email": email,
        "roles": roles,
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
    users_file = db_dir / 'users.json'
    users_data = get_users_data(users_file)

    # Check if user already exists
    if user_exists(username, users_data):
        return False, f"User '{username}' already exists."

    # Add new user
    new_user = create_user(username, password, fullname, email)
    users_data.append(new_user)

    save_users_data(users_file, users_data)
    return True, f"User '{username}' added successfully."


def remove_user(db_dir: Path, username: str) -> tuple[bool, str]:
    """Removes a user from the users.json file.

    Args:
        db_dir: Path to the db directory
        username: The username to remove

    Returns:
        Tuple of (success: bool, message: str)
    """
    users_file = db_dir / 'users.json'
    users_data = get_users_data(users_file)

    if not user_exists(username, users_data):
        return False, f"User '{username}' not found."

    users_data = [user for user in users_data if user.get('username') != username]
    save_users_data(users_file, users_data)
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
    users_file = db_dir / 'users.json'
    users_data = get_users_data(users_file)

    user = find_user(username, users_data)
    if not user:
        return False, f"User '{username}' not found."

    user['passwd_hash'] = hash_password(password)
    save_users_data(users_file, users_data)
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

    users_file = db_dir / 'users.json'
    users_data = get_users_data(users_file)

    user = find_user(username, users_data)
    if not user:
        return False, f"User '{username}' not found."

    if role_name not in user['roles']:
        user['roles'].append(role_name)
        save_users_data(users_file, users_data)
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

    users_file = db_dir / 'users.json'
    users_data = get_users_data(users_file)

    user = find_user(username, users_data)
    if not user:
        return False, f"User '{username}' not found."

    if role_name in user['roles']:
        user['roles'].remove(role_name)
        save_users_data(users_file, users_data)
        return True, f"Role '{role_name}' removed from user '{username}'."
    else:
        return False, f"User '{username}' does not have the role '{role_name}'."


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
    users_file = db_dir / 'users.json'
    users_data = get_users_data(users_file)

    # Check for username conflicts if changing username
    if property_name == 'username':
        if user_exists(value, users_data):
            return False, f"User with username '{value}' already exists."

    user = find_user(username, users_data)
    if not user:
        return False, f"User '{username}' not found."

    user[property_name] = value
    save_users_data(users_file, users_data)

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
    users_file = db_dir / 'users.json'
    return get_users_data(users_file)