#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path
import getpass

def setup_imports():
    """Setup imports for the utility modules."""
    # Add the server directory to the Python path for imports
    server_path = Path(__file__).resolve().parent.parent / 'server'
    if str(server_path) not in sys.path:
        sys.path.insert(0, str(server_path))

# Setup imports
setup_imports()

# Import utility modules
# type: ignore comments help Pylance understand these are valid imports
from lib.data_utils import get_project_paths  # type: ignore
from lib.user_utils import (  # type: ignore
    add_user as user_add_user, remove_user as user_remove_user,
    update_user_password, add_role_to_user, remove_role_from_user,
    set_user_property as user_set_property, list_users as user_list_users
)
from lib.role_utils import get_roles_with_details, get_available_roles  # type: ignore
from lib.config_utils import (  # type: ignore
    get_config_value, set_config_value, delete_config_key,
    set_config_constraint, get_config_data
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
    """Lists all users in the format 'Fullname (username) [email]: Role1, Role2'."""
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
        email_part = f" [{email}]" if email else ""
        print(f"{fullname} ({username}){email_part}: {roles}")

def set_user_property(args):
    """Sets a scalar, unencrypted property for a user."""
    db_dir, _ = get_project_paths(args.db_path, args.config_path)
    success, message = user_set_property(db_dir, args.username, args.property, args.value)
    print(message)


def set_config(args):
    """Sets a configuration value."""
    db_dir, config_dir = get_project_paths(args.db_path, args.config_path)

    # Determine which config files to update
    config_files = [db_dir / 'config.json']
    if args.default:
        config_files.append(config_dir / 'config.json')

    key = args.key

    # Handle shorthand for setting values
    if args.values is not None:
        try:
            values_list = json.loads(args.values)
            if not isinstance(values_list, list):
                print("Error: --values must be a JSON array")
                return

            # Update all config files
            for config_file in config_files:
                success, message = set_config_constraint(config_file, key, "values", values_list)
                if not success:
                    print(f"Error updating {config_file}: {message}")
                    return

            locations = "db and default config" if args.default else "db config"
            print(f"Set {key}.values to {values_list} in {locations}")
            return
        except json.JSONDecodeError:
            print("Error: --values must be valid JSON array")
            return

    # Handle shorthand for setting type
    if args.type is not None:
        # Update all config files
        for config_file in config_files:
            success, message = set_config_constraint(config_file, key, "type", args.type)
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

    # Update all config files
    for config_file in config_files:
        success, message = set_config_value(config_file, key, value)
        if not success:
            print(f"Error: {message}")
            return

    locations = "db and default config" if args.default else "db config"
    print(f"Set {key} to {json.dumps(value)} in {locations}")

def get_config(args):
    """Gets a configuration value."""
    db_dir, config_dir = get_project_paths(args.db_path, args.config_path)

    # Determine which config file to read from
    if args.default:
        config_file = config_dir / 'config.json'
        location = "default config"
    else:
        config_file = db_dir / 'config.json'
        location = "db config"

    value = get_config_value(config_file, args.key)
    if value is not None:
        print(json.dumps(value))
    else:
        print(f"Error: Key '{args.key}' not found in {location}")

def delete_config(args):
    """Deletes a configuration key."""
    db_dir, config_dir = get_project_paths(args.db_path, args.config_path)

    # Determine which config files to delete from
    config_files = [db_dir / 'config.json']
    if args.default:
        config_files.append(config_dir / 'config.json')

    key = args.key
    deleted_from = []
    not_found_in = []

    # Delete from all specified config files
    for config_file in config_files:
        success, message = delete_config_key(config_file, key)
        location = "default config" if config_file.parent.name == "config" else "db config"

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
    parser.add_argument('--db-path', help='Path to the db directory (default: ./db)')
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
    all_subparsers = {'user': user_parser, 'config': config_parser}
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
        elif hasattr(args, 'command') and args.command == 'config' and not args.subcommand:
             config_parser.print_help()
        else:
             parser.print_help()
