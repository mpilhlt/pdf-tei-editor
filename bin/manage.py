#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path
import getpass

def setup_imports():
    """Setup imports for the utility modules."""
    # Add the fastapi_app directory to the Python path for imports
    fastapi_app_path = Path(__file__).resolve().parent.parent / 'fastapi_app'
    if str(fastapi_app_path) not in sys.path:
        sys.path.insert(0, str(fastapi_app_path))

# Setup imports
setup_imports()

# Import utility modules
# type: ignore comments help Pylance understand these are valid imports
from lib.data_utils import get_project_paths  # type: ignore
from lib.user_utils import (  # type: ignore
    add_user as user_add_user, remove_user as user_remove_user,
    update_user_password, add_role_to_user, remove_role_from_user,
    add_group_to_user, remove_group_from_user,
    set_user_property as user_set_property, list_users as user_list_users
)
from lib.role_utils import get_roles_with_details, get_available_roles  # type: ignore
from lib.group_utils import (  # type: ignore
    add_group as group_add_group, remove_group as group_remove_group,
    set_group_property as group_set_property, list_groups as group_list_groups,
    add_collection_to_group, remove_collection_from_group, get_groups_with_details
)
from lib.collection_utils import (  # type: ignore
    add_collection as collection_add_collection, remove_collection as collection_remove_collection,
    set_collection_property as collection_set_property, list_collections as collection_list_collections,
    get_collections_with_details
)
from lib.config_utils import (  # type: ignore
    get_config_value, set_config_value, delete_config_value
)

def list_available_roles(db_dir):
    """Lists all available roles with their descriptions."""
    try:
        roles_data = get_roles_with_details(db_dir)
        print("Available roles:")
        for role in roles_data:
            if isinstance(role, dict) and 'id' in role:
                role_id = role['id']
                role_name = role.get('roleName', 'No description')
                description = role.get('description', '')
                if description:
                    print(f"  {role_id} ({role_name}: {description})")
                else:
                    print(f"  {role_id}: {role_name}")
    except (FileNotFoundError, ValueError) as e:
        print(f"Error: {e}")

def list_available_groups(db_dir):
    """Lists all available groups with their descriptions."""
    try:
        groups_data = get_groups_with_details(db_dir)
        print("Available groups:")
        for group in groups_data:
            if isinstance(group, dict) and 'id' in group:
                group_id = group['id']
                group_name = group.get('name', 'No name')
                description = group.get('description', '')
                collections = ', '.join(group.get('collections', []))
                collections_part = f" [Collections: {collections}]" if collections else ""
                if description:
                    print(f"  {group_id} ({group_name}: {description}){collections_part}")
                else:
                    print(f"  {group_id}: {group_name}{collections_part}")
    except (FileNotFoundError, ValueError) as e:
        print(f"Error: {e}")

def list_available_collections(db_dir):
    """Lists all available collections with their descriptions."""
    try:
        collections_data = get_collections_with_details(db_dir)
        print("Available collections:")
        for collection in collections_data:
            if isinstance(collection, dict) and 'id' in collection:
                collection_id = collection['id']
                collection_name = collection.get('name', 'No name')
                description = collection.get('description', '')
                if description:
                    print(f"  {collection_id} ({collection_name}: {description})")
                else:
                    print(f"  {collection_id}: {collection_name}")
    except (FileNotFoundError, ValueError) as e:
        print(f"Error: {e}")

def add_user(args):
    """Adds a new user to the users.json file."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)

    password = args.password
    if password is None:
        password = getpass.getpass("Enter password: ")
        password_confirm = getpass.getpass("Confirm password: ")
        if password != password_confirm:
            print("Passwords do not match.")
            return

    # Parse roles if provided
    roles_to_add = []
    if hasattr(args, 'roles') and args.roles:
        # Split comma-separated roles and validate them
        roles_to_add = [role.strip() for role in args.roles.split(',') if role.strip()]

        # Validate roles exist
        available_roles = get_available_roles(db_dir)
        if available_roles is None:
            print("Error: Could not load available roles")
            return

        invalid_roles = [role for role in roles_to_add if role not in available_roles]
        if invalid_roles:
            print(f"Error: Invalid role(s): {', '.join(invalid_roles)}")
            print("Available roles:")
            list_available_roles(db_dir)
            return

    # Create user first
    success, message = user_add_user(db_dir, args.username, password, args.fullname or "", args.email or "")
    if not success:
        print(message)
        return

    print(message)

    # Add roles if specified
    if roles_to_add:
        for role in roles_to_add:
            success, role_message = add_role_to_user(db_dir, args.username, role)
            if success:
                print(f"Added role '{role}' to user '{args.username}'")
            else:
                print(f"Failed to add role '{role}': {role_message}")

    # Add default group
    success, group_message = add_group_to_user(db_dir, args.username, "default")
    if success:
        print(f"Added user to default group")
    else:
        print(f"Warning: Could not add user to default group: {group_message}")

def remove_user(args):
    """Removes a user from the users.json file."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)
    success, message = user_remove_user(db_dir, args.username)
    print(message)

def update_password(args):
    """Updates a user's password."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)

    password = args.password
    if not password:
        password = getpass.getpass("Enter new password: ")
        password_confirm = getpass.getpass("Confirm new password: ")
        if password != password_confirm:
            print("Passwords do not match.")
            return

    success, message = update_user_password(db_dir, args.username, password)
    print(message)

def add_role(args):
    """Adds a role to a user."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)

    # If no role is provided, list available roles
    if not args.rolename:
        list_available_roles(db_dir)
        return

    success, message = add_role_to_user(db_dir, args.username, args.rolename)
    if not success and "not a valid role" in message:
        print(message)
        list_available_roles(db_dir)
    else:
        print(message)

def remove_role(args):
    """Removes a role from a user."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)

    # If no role is provided, list available roles
    if not args.rolename:
        list_available_roles(db_dir)
        return

    success, message = remove_role_from_user(db_dir, args.username, args.rolename)
    if not success and "not a valid role" in message:
        print(message)
        list_available_roles(db_dir)
    else:
        print(message)

def list_users(args):
    """Lists all users in the format 'Fullname (username) [email]: Role1, Role2 | Groups: group1, group2'."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)
    users_data = user_list_users(db_dir)

    if not users_data:
        print("No users found.")
        return

    for user in users_data:
        fullname = user.get('fullname') or 'N/A'
        username = user.get('username')
        email = user.get('email', '')
        roles = ', '.join(user.get('roles', []))
        groups = ', '.join(user.get('groups', []))
        email_part = f" [{email}]" if email else ""
        groups_part = f" | Groups: {groups}" if groups else ""
        print(f"{fullname} ({username}){email_part}: {roles}{groups_part}")

def set_user_property(args):
    """Sets a scalar, unencrypted property for a user."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)
    success, message = user_set_property(db_dir, args.username, args.property, args.value)
    print(message)

def add_user_group(args):
    """Adds a group to a user."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)

    # If no group is provided, list available groups
    if not args.groupid:
        list_available_groups(db_dir)
        return

    success, message = add_group_to_user(db_dir, args.username, args.groupid)
    if not success and "not a valid group" in message:
        print(message)
        list_available_groups(db_dir)
    else:
        print(message)

def remove_user_group(args):
    """Removes a group from a user."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)

    # If no group is provided, list available groups
    if not args.groupid:
        list_available_groups(db_dir)
        return

    success, message = remove_group_from_user(db_dir, args.username, args.groupid)
    if not success and "not a valid group" in message:
        print(message)
        list_available_groups(db_dir)
    else:
        print(message)


def add_group(args):
    """Adds a new group to the groups.json file."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)
    success, message = group_add_group(db_dir, args.groupid, args.name, args.description or "")
    print(message)

def remove_group(args):
    """Removes a group from the groups.json file."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)
    success, message = group_remove_group(db_dir, args.groupid)
    print(message)

def set_group_property(args):
    """Sets a property for a group."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)
    success, message = group_set_property(db_dir, args.groupid, args.property, args.value)
    print(message)

def list_groups(args):
    """Lists all groups."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)
    groups_data = group_list_groups(db_dir)

    if not groups_data:
        print("No groups found.")
        return

    for group in groups_data:
        group_id = group.get('id')
        name = group.get('name', '')
        description = group.get('description', '')
        collections = ', '.join(group.get('collections', []))
        desc_part = f" ({description})" if description else ""
        collections_part = f" [Collections: {collections}]" if collections else ""
        print(f"{group_id}: {name}{desc_part}{collections_part}")

def add_group_collection(args):
    """Adds a collection to a group."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)

    # If no collection is provided, list available collections
    if not args.collectionid:
        list_available_collections(db_dir)
        return

    success, message = add_collection_to_group(db_dir, args.groupid, args.collectionid)
    if not success and "not a valid collection" in message:
        print(message)
        list_available_collections(db_dir)
    else:
        print(message)

def remove_group_collection(args):
    """Removes a collection from a group."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)

    # If no collection is provided, list available collections
    if not args.collectionid:
        list_available_collections(db_dir)
        return

    success, message = remove_collection_from_group(db_dir, args.groupid, args.collectionid)
    if not success and "not a valid collection" in message:
        print(message)
        list_available_collections(db_dir)
    else:
        print(message)

def add_collection(args):
    """Adds a new collection to the collections.json file."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)
    success, message = collection_add_collection(db_dir, args.collectionid, args.name, args.description or "")
    print(message)

def remove_collection(args):
    """Removes a collection from the collections.json file."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)
    success, message = collection_remove_collection(db_dir, args.collectionid)
    print(message)

def set_collection_property(args):
    """Sets a property for a collection."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)
    success, message = collection_set_property(db_dir, args.collectionid, args.property, args.value)
    print(message)

def list_collections(args):
    """Lists all collections."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)
    collections_data = collection_list_collections(db_dir)

    if not collections_data:
        print("No collections found.")
        return

    for collection in collections_data:
        collection_id = collection.get('id')
        name = collection.get('name', '')
        description = collection.get('description', '')
        desc_part = f" ({description})" if description else ""
        print(f"{collection_id}: {name}{desc_part}")


def set_config(args):
    """Sets a configuration value."""
    db_dir, config_dir = get_project_paths(args.db_path, args.config_path)

    # Determine which directories to update
    dirs_to_update = [db_dir]
    if args.default:
        dirs_to_update.append(config_dir)

    key = args.key

    # Handle shorthand for setting values constraint
    if args.values is not None:
        try:
            values_list = json.loads(args.values)
            if not isinstance(values_list, list):
                print("Error: --values must be a JSON array")
                return

            # Update all config dirs
            for dir_path in dirs_to_update:
                success, message = set_config_value(f"{key}.values", values_list, dir_path)
                if not success:
                    print(f"Error updating {dir_path}: {message}")
                    return

            locations = "db and default config" if args.default else "db config"
            print(f"Set {key}.values to {values_list} in {locations}")
            return
        except json.JSONDecodeError:
            print("Error: --values must be valid JSON array")
            return

    # Handle shorthand for setting type constraint
    if args.type is not None:
        # Update all config dirs
        for dir_path in dirs_to_update:
            success, message = set_config_value(f"{key}.type", args.type, dir_path)
            if not success:
                print(f"Error: {message}")
                return

        locations = "db and default config" if args.default else "db config"
        print(f"Set {key}.type to {args.type} in {locations}")
        return

    # Check if value is provided
    if args.value is None:
        print("Error: Value is required when not using --values or --type")
        return

    # Parse the JSON value
    try:
        value = json.loads(args.value)
    except json.JSONDecodeError:
        print("Error: Value must be valid JSON")
        return

    # Update all config dirs
    for dir_path in dirs_to_update:
        success, message = set_config_value(key, value, dir_path)
        if not success:
            print(f"Error: {message}")
            return

    locations = "db and default config" if args.default else "db config"
    print(f"Set {key} to {json.dumps(value)} in {locations}")

def get_config(args):
    """Gets a configuration value."""
    db_dir, config_dir = get_project_paths(args.db_path, args.config_path)

    # Determine which directory to read from
    if args.default:
        dir_path = config_dir
        location = "default config"
    else:
        dir_path = db_dir
        location = "db config"

    value = get_config_value(args.key, dir_path)
    if value is not None:
        print(json.dumps(value))
    else:
        print(f"Error: Key '{args.key}' not found in {location}")

def delete_config(args):
    """Deletes a configuration key."""
    db_dir, config_dir = get_project_paths(args.db_path, args.config_path)

    # Determine which directories to delete from
    dirs_to_update = [(db_dir, "db config")]
    if args.default:
        dirs_to_update.append((config_dir, "default config"))

    key = args.key
    deleted_from = []
    not_found_in = []

    # Delete from all specified config dirs
    for dir_path, location in dirs_to_update:
        success, message = delete_config_value(key, dir_path)

        if success:
            deleted_from.append(location)
        elif "not found" in message:
            not_found_in.append(location)

    # Report results
    if deleted_from:
        locations = " and ".join(deleted_from)
        print(f"Deleted key '{key}' from {locations}")

    if not_found_in:
        locations = " and ".join(not_found_in)
        print(f"Key '{key}' not found in {locations}")

    if not deleted_from and not not_found_in:
        print(f"Error: Could not access config files")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description="A command-line tool to manage the PDF-TEI-Editor application.",
        epilog="Use 'manage.py <command> --help' for more information on a specific command.",
        formatter_class=argparse.RawTextHelpFormatter)

    # Global arguments
    parser.add_argument('--db-path', help='Path to the db directory (default: ./data/db)')
    parser.add_argument('--config-path', help='Path to the config directory (default: ./config)')

    subparsers = parser.add_subparsers(dest='command', title='Available commands')

    # --- User management ---
    user_parser = subparsers.add_parser('user', help='Manage users', description='Provides commands to manage application users.')
    user_subparsers = user_parser.add_subparsers(dest='subcommand', title='User management commands', description="Use 'manage.py user <subcommand> --help' for details on each command.")

    # user list
    parser_list = user_subparsers.add_parser('list', help='List all users', description=list_users.__doc__)
    parser_list.set_defaults(func=list_users)

    # user add
    parser_add = user_subparsers.add_parser('add', help='Add a new user', description=add_user.__doc__)
    parser_add.add_argument('username', help='The username of the new user.')
    parser_add.add_argument('--password', help='The password for the new user. If not provided, it will be asked for interactively.', nargs='?', default=None)
    parser_add.add_argument('--fullname', help='The full name of the user.', default="")
    parser_add.add_argument('--email', help='The email address of the user.', default="")
    parser_add.add_argument('--roles', help='Comma-separated list of roles to assign to the user (e.g., "user,annotator").', default="")
    parser_add.set_defaults(func=add_user)

    # user remove
    parser_remove = user_subparsers.add_parser('remove', help='Remove a user', description=remove_user.__doc__)
    parser_remove.add_argument('username', help='The username of the user to remove.')
    parser_remove.set_defaults(func=remove_user)

    # user set
    parser_set = user_subparsers.add_parser('set', help='Set a user property.', description=set_user_property.__doc__)
    parser_set.add_argument('username', help='The username of the user to update.')
    parser_set.add_argument('property', help='The property to set.', choices=['fullname', 'username', 'email'])
    parser_set.add_argument('value', help='The new value for the property.')
    parser_set.set_defaults(func=set_user_property)

    # user update-password
    parser_update_password = user_subparsers.add_parser('update-password', help="Update a user's password", description=update_password.__doc__)
    parser_update_password.add_argument('username', help='The username of the user to update.')
    parser_update_password.add_argument('password', nargs='?', default=None, help="The new password. If not provided, it will be asked for interactively.")
    parser_update_password.set_defaults(func=update_password)

    # user add role
    parser_add_role = user_subparsers.add_parser('add-role', help='Add a role to a user', description=add_role.__doc__)
    parser_add_role.add_argument('username', help='The username of the user.')
    parser_add_role.add_argument('rolename', nargs='?', help='The role to add. If not provided, lists available roles.')
    parser_add_role.set_defaults(func=add_role)

    # user remove role
    parser_remove_role = user_subparsers.add_parser('remove-role', help='Remove a role from a user', description=remove_role.__doc__)
    parser_remove_role.add_argument('username', help='The username of the user.')
    parser_remove_role.add_argument('rolename', nargs='?', help='The role to remove. If not provided, lists available roles.')
    parser_remove_role.set_defaults(func=remove_role)

    # user add-group
    parser_add_user_group = user_subparsers.add_parser('add-group', help='Add a group to a user', description=add_user_group.__doc__)
    parser_add_user_group.add_argument('username', help='The username of the user.')
    parser_add_user_group.add_argument('groupid', nargs='?', help='The group ID to add. If not provided, lists available groups.')
    parser_add_user_group.set_defaults(func=add_user_group)

    # user remove-group
    parser_remove_user_group = user_subparsers.add_parser('remove-group', help='Remove a group from a user', description=remove_user_group.__doc__)
    parser_remove_user_group.add_argument('username', help='The username of the user.')
    parser_remove_user_group.add_argument('groupid', nargs='?', help='The group ID to remove. If not provided, lists available groups.')
    parser_remove_user_group.set_defaults(func=remove_user_group)

    # --- Group management ---
    group_parser = subparsers.add_parser('group', help='Manage groups', description='Provides commands to manage application groups.')
    group_subparsers = group_parser.add_subparsers(dest='subcommand', title='Group management commands', description="Use 'manage.py group <subcommand> --help' for details on each command.")

    # group list
    parser_list_groups = group_subparsers.add_parser('list', help='List all groups', description=list_groups.__doc__)
    parser_list_groups.set_defaults(func=list_groups)

    # group add
    parser_add_group = group_subparsers.add_parser('add', help='Add a new group', description=add_group.__doc__)
    parser_add_group.add_argument('groupid', help='The group ID.')
    parser_add_group.add_argument('name', help='The group name.')
    parser_add_group.add_argument('--description', help='The group description.', default="")
    parser_add_group.set_defaults(func=add_group)

    # group remove
    parser_remove_group = group_subparsers.add_parser('remove', help='Remove a group', description=remove_group.__doc__)
    parser_remove_group.add_argument('groupid', help='The group ID to remove.')
    parser_remove_group.set_defaults(func=remove_group)

    # group set
    parser_set_group = group_subparsers.add_parser('set', help='Set a group property', description=set_group_property.__doc__)
    parser_set_group.add_argument('groupid', help='The group ID.')
    parser_set_group.add_argument('property', help='The property to set.', choices=['id', 'name', 'description'])
    parser_set_group.add_argument('value', help='The new value for the property.')
    parser_set_group.set_defaults(func=set_group_property)

    # group add-collection
    parser_add_group_collection = group_subparsers.add_parser('add-collection', help='Add a collection to a group', description=add_group_collection.__doc__)
    parser_add_group_collection.add_argument('groupid', help='The group ID.')
    parser_add_group_collection.add_argument('collectionid', nargs='?', help='The collection ID to add. If not provided, lists available collections.')
    parser_add_group_collection.set_defaults(func=add_group_collection)

    # group remove-collection
    parser_remove_group_collection = group_subparsers.add_parser('remove-collection', help='Remove a collection from a group', description=remove_group_collection.__doc__)
    parser_remove_group_collection.add_argument('groupid', help='The group ID.')
    parser_remove_group_collection.add_argument('collectionid', nargs='?', help='The collection ID to remove. If not provided, lists available collections.')
    parser_remove_group_collection.set_defaults(func=remove_group_collection)

    # --- Collection management ---
    collection_parser = subparsers.add_parser('collection', help='Manage collections', description='Provides commands to manage application collections.')
    collection_subparsers = collection_parser.add_subparsers(dest='subcommand', title='Collection management commands', description="Use 'manage.py collection <subcommand> --help' for details on each command.")

    # collection list
    parser_list_collections = collection_subparsers.add_parser('list', help='List all collections', description=list_collections.__doc__)
    parser_list_collections.set_defaults(func=list_collections)

    # collection add
    parser_add_collection = collection_subparsers.add_parser('add', help='Add a new collection', description=add_collection.__doc__)
    parser_add_collection.add_argument('collectionid', help='The collection ID.')
    parser_add_collection.add_argument('name', help='The collection name.')
    parser_add_collection.add_argument('--description', help='The collection description.', default="")
    parser_add_collection.set_defaults(func=add_collection)

    # collection remove
    parser_remove_collection = collection_subparsers.add_parser('remove', help='Remove a collection', description=remove_collection.__doc__)
    parser_remove_collection.add_argument('collectionid', help='The collection ID to remove.')
    parser_remove_collection.set_defaults(func=remove_collection)

    # collection set
    parser_set_collection = collection_subparsers.add_parser('set', help='Set a collection property', description=set_collection_property.__doc__)
    parser_set_collection.add_argument('collectionid', help='The collection ID.')
    parser_set_collection.add_argument('property', help='The property to set.', choices=['id', 'name', 'description'])
    parser_set_collection.add_argument('value', help='The new value for the property.')
    parser_set_collection.set_defaults(func=set_collection_property)

    # --- Config management ---
    config_parser = subparsers.add_parser('config', help='Manage configuration', description='Provides commands to manage application configuration.')
    config_subparsers = config_parser.add_subparsers(dest='subcommand', title='Config management commands', description="Use 'manage.py config <subcommand> --help' for details on each command.")

    # config get
    parser_config_get = config_subparsers.add_parser('get', help='Get a configuration value', description=get_config.__doc__)
    parser_config_get.add_argument('key', help='The configuration key to get.')
    parser_config_get.add_argument('--default', action='store_true', help='Read from config/config.json instead of db/config.json.')
    parser_config_get.set_defaults(func=get_config)

    # config set
    parser_config_set = config_subparsers.add_parser('set', help='Set a configuration value', description=set_config.__doc__)
    parser_config_set.add_argument('key', help='The configuration key to set.')
    parser_config_set.add_argument('value', nargs='?', help='The JSON value to set. Required unless using --values or --type.')
    parser_config_set.add_argument('--values', help='Set the values constraint for this key (JSON array).')
    parser_config_set.add_argument('--type', help='Set the type constraint for this key.')
    parser_config_set.add_argument('--default', action='store_true', help='Set in both db/config.json and config/config.json.')
    parser_config_set.set_defaults(func=set_config)

    # config delete
    parser_config_delete = config_subparsers.add_parser('delete', help='Delete a configuration key', description=delete_config.__doc__)
    parser_config_delete.add_argument('key', help='The configuration key to delete.')
    parser_config_delete.add_argument('--default', action='store_true', help='Delete from both db/config.json and config/config.json.')
    parser_config_delete.set_defaults(func=delete_config)

    # --- Help command ---
    all_subparsers = {'user': user_parser, 'group': group_parser, 'collection': collection_parser, 'config': config_parser}
    def show_help(args):
        command = args.command_name
        if command:
            if command in all_subparsers:
                all_subparsers[command].print_help()
            else:
                print(f"Error: Unknown command '{command}'")
                parser.print_help()
        else:
            parser.print_help()

    help_parser = subparsers.add_parser('help', help='Show help for a command.')
    help_parser.add_argument('command_name', nargs='?', help='The command to get help for.')
    help_parser.set_defaults(func=show_help)

    # --- Argument Parsing ---
    args = parser.parse_args()

    if hasattr(args, 'func'):
        args.func(args)
    else:
        if hasattr(args, 'command') and args.command == 'user' and not args.subcommand:
             user_parser.print_help()
        elif hasattr(args, 'command') and args.command == 'group' and not args.subcommand:
             group_parser.print_help()
        elif hasattr(args, 'command') and args.command == 'collection' and not args.subcommand:
             collection_parser.print_help()
        elif hasattr(args, 'command') and args.command == 'config' and not args.subcommand:
             config_parser.print_help()
        else:
             parser.print_help()
