#!/usr/bin/env python3
import argparse
import json
import hashlib
from pathlib import Path
import getpass

def get_project_paths(args=None):
    """Get project paths from command line arguments or defaults."""
    if args and hasattr(args, 'db_path') and args.db_path:
        db_dir = Path(args.db_path)
    else:
        project_root = Path(__file__).resolve().parent.parent
        db_dir = project_root / 'db'

    if args and hasattr(args, 'config_path') and args.config_path:
        config_dir = Path(args.config_path)
    else:
        project_root = Path(__file__).resolve().parent.parent
        config_dir = project_root / 'config'

    return db_dir, config_dir

def get_users_data(users_file):
    if not users_file.exists():
        print(f"Error: {users_file} not found. Please start the application first to create it.")
        return None

    with open(users_file, 'r', encoding='utf-8') as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return []

def save_users_data(users_file, data):
    with open(users_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
        f.truncate()

def add_user(args):
    """Adds a new user to the users.json file."""
    db_dir, _ = get_project_paths(args)
    users_file = db_dir / 'users.json'
    
    password = args.password
    if not password:
        password = getpass.getpass("Enter password: ")
        password_confirm = getpass.getpass("Confirm password: ")
        if password != password_confirm:
            print("Passwords do not match.")
            return

    users_data = get_users_data(users_file)
    if users_data is None:
        return

    # Check if user already exists
    if any(user.get('username') == args.username for user in users_data):
        print(f"Error: User '{args.username}' already exists.")
        return

    # Hash the password
    passwd_hash = hashlib.sha256(password.encode('utf-8')).hexdigest()

    # Add new user
    users_data.append({
        "username": args.username,
        "fullname": args.fullname or "",
        "email": args.email or "",
        "roles": ["user"],
        "passwd_hash": passwd_hash,
        "session_id": None
    })

    save_users_data(users_file, users_data)
    print(f"User '{args.username}' added successfully.")

def remove_user(args):
    """Removes a user from the users.json file."""
    db_dir, _ = get_project_paths(args)
    users_file = db_dir / 'users.json'

    users_data = get_users_data(users_file)
    if users_data is None:
        return

    user_exists = any(user.get('username') == args.username for user in users_data)
    if not user_exists:
        print(f"Error: User '{args.username}' not found.")
        return

    users_data = [user for user in users_data if user.get('username') != args.username]
    
    save_users_data(users_file, users_data)
    print(f"User '{args.username}' removed successfully.")

def update_password(args):
    """Updates a user's password."""
    db_dir, _ = get_project_paths(args)
    users_file = db_dir / 'users.json'

    password = args.password
    if not password:
        password = getpass.getpass("Enter new password: ")
        password_confirm = getpass.getpass("Confirm new password: ")
        if password != password_confirm:
            print("Passwords do not match.")
            return

    users_data = get_users_data(users_file)
    if users_data is None:
        return

    user_found = False
    for user in users_data:
        if user.get('username') == args.username:
            user['passwd_hash'] = hashlib.sha256(password.encode('utf-8')).hexdigest()
            user_found = True
            break
    
    if not user_found:
        print(f"Error: User '{args.username}' not found.")
        return

    save_users_data(users_file, users_data)
    print(f"Password for user '{args.username}' updated successfully.")

def add_role(args):
    """Adds a role to a user."""
    db_dir, _ = get_project_paths(args)
    users_file = db_dir / 'users.json'

    users_data = get_users_data(users_file)
    if users_data is None:
        return

    user_found = False
    for user in users_data:
        if user.get('username') == args.username:
            if args.rolename not in user['roles']:
                user['roles'].append(args.rolename)
                print(f"Role '{args.rolename}' added to user '{args.username}'.")
            else:
                print(f"User '{args.username}' already has the role '{args.rolename}'.")
            user_found = True
            break

    if not user_found:
        print(f"Error: User '{args.username}' not found.")
        return

    save_users_data(users_file, users_data)

def remove_role(args):
    """Removes a role from a user."""
    db_dir, _ = get_project_paths(args)
    users_file = db_dir / 'users.json'

    users_data = get_users_data(users_file)
    if users_data is None:
        return

    user_found = False
    for user in users_data:
        if user.get('username') == args.username:
            if args.rolename in user['roles']:
                user['roles'].remove(args.rolename)
                print(f"Role '{args.rolename}' removed from user '{args.username}'.")
            else:
                print(f"User '{args.username}' does not have the role '{args.rolename}'.")
            user_found = True
            break

    if not user_found:
        print(f"Error: User '{args.username}' not found.")
        return

    save_users_data(users_file, users_data)

def list_users(args):
    """Lists all users in the format 'Fullname (username) [email]: Role1, Role2'."""
    db_dir, _ = get_project_paths(args)
    users_file = db_dir / 'users.json'

    users_data = get_users_data(users_file)
    if users_data is None:
        return

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
    db_dir, _ = get_project_paths(args)
    users_file = db_dir / 'users.json'

    users_data = get_users_data(users_file)
    if users_data is None:
        return

    if args.property == 'username':
        if any(u.get('username') == args.value for u in users_data):
            print(f"Error: User with username '{args.value}' already exists.")
            return

    user_found = False
    for user in users_data:
        if user.get('username') == args.username:
            user[args.property] = args.value
            print(f"Property '{args.property}' for user '{args.username}' set to '{args.value}'.")
            if args.property == 'username':
                print(f"User '{args.username}' is now '{args.value}'.")
            user_found = True
            break

    if not user_found:
        print(f"Error: User '{args.username}' not found.")
        return

    save_users_data(users_file, users_data)

def get_config_data(config_file):
    """Gets configuration data from config.json file."""
    if not config_file.exists():
        print(f"Error: {config_file} not found.")
        return None

    with open(config_file, 'r', encoding='utf-8') as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            print(f"Error: Invalid JSON in {config_file}")
            return None

def save_config_data(config_file, data):
    """Saves configuration data to config.json file."""
    with open(config_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)

def get_json_type(value):
    """Returns the JSON type name for a Python value."""
    if isinstance(value, bool):
        return "boolean"
    elif isinstance(value, int):
        return "number"
    elif isinstance(value, float):
        return "number"
    elif isinstance(value, str):
        return "string"
    elif isinstance(value, list):
        return "array"
    elif isinstance(value, dict):
        return "object"
    elif value is None:
        return "null"
    else:
        return "unknown"

def validate_config_value(config_data, key, value):
    """Validates a config value against constraints."""
    values_key = f"{key}.values"
    type_key = f"{key}.type"

    # Check if value must be one of specific values
    if values_key in config_data:
        allowed_values = config_data[values_key]
        if value not in allowed_values:
            print(f"Error: Value must be one of {allowed_values}")
            return False

    # Check if value must be of specific type
    if type_key in config_data:
        required_type = config_data[type_key]
        actual_type = get_json_type(value)
        if actual_type != required_type:
            print(f"Error: Value must be of type {required_type}, got {actual_type}")
            return False

    return True

def set_config(args):
    """Sets a configuration value."""
    db_dir, config_dir = get_project_paths(args)

    # Determine which config files to update
    config_files = [db_dir / 'config.json']
    if args.default:
        config_files.append(config_dir / 'config.json')

    # Load the primary config data for validation
    primary_config_data = get_config_data(config_files[0])
    if primary_config_data is None:
        return

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
                config_data = get_config_data(config_file)
                if config_data is not None:
                    config_data[f"{key}.values"] = values_list
                    save_config_data(config_file, config_data)

            locations = "db and default config" if args.default else "db config"
            print(f"Set {key}.values to {values_list} in {locations}")
            return
        except json.JSONDecodeError:
            print("Error: --values must be valid JSON array")
            return

    # Handle shorthand for setting type
    if args.type is not None:
        valid_types = ["string", "number", "boolean", "array", "object", "null"]
        if args.type not in valid_types:
            print(f"Error: Type must be one of {valid_types}")
            return

        # Update all config files
        for config_file in config_files:
            config_data = get_config_data(config_file)
            if config_data is not None:
                config_data[f"{key}.type"] = args.type
                save_config_data(config_file, config_data)

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

    # Special validation for *.values keys
    if key.endswith(".values") and not isinstance(value, list):
        print("Error: Values keys must be arrays")
        return

    # Special validation for *.type keys
    if key.endswith(".type"):
        valid_types = ["string", "number", "boolean", "array", "object", "null"]
        if value not in valid_types:
            print(f"Error: Type must be one of {valid_types}")
            return

    # Validate against existing constraints
    if not validate_config_value(primary_config_data, key, value):
        return

    # Update all config files
    for config_file in config_files:
        config_data = get_config_data(config_file)
        if config_data is not None:
            # Set the value
            config_data[key] = value

            # Auto-set type for new keys (not ending in .values or .type)
            if not key.endswith(".values") and not key.endswith(".type"):
                type_key = f"{key}.type"
                if type_key not in config_data:
                    config_data[type_key] = get_json_type(value)

            save_config_data(config_file, config_data)

    locations = "db and default config" if args.default else "db config"
    print(f"Set {key} to {json.dumps(value)} in {locations}")

def get_config(args):
    """Gets a configuration value."""
    db_dir, config_dir = get_project_paths(args)

    # Determine which config file to read from
    if args.default:
        config_file = config_dir / 'config.json'
        location = "default config"
    else:
        config_file = db_dir / 'config.json'
        location = "db config"

    config_data = get_config_data(config_file)
    if config_data is None:
        return

    key = args.key
    if key in config_data:
        print(json.dumps(config_data[key]))
    else:
        print(f"Error: Key '{key}' not found in {location}")

def delete_config(args):
    """Deletes a configuration key."""
    db_dir, config_dir = get_project_paths(args)

    # Determine which config files to delete from
    config_files = [db_dir / 'config.json']
    if args.default:
        config_files.append(config_dir / 'config.json')

    key = args.key
    deleted_from = []
    not_found_in = []

    # Delete from all specified config files
    for config_file in config_files:
        config_data = get_config_data(config_file)
        if config_data is not None:
            if key in config_data:
                del config_data[key]
                save_config_data(config_file, config_data)
                location = "default config" if config_file.parent.name == "config" else "db config"
                deleted_from.append(location)
            else:
                location = "default config" if config_file.parent.name == "config" else "db config"
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
    parser_add_role.add_argument('rolename', help='The role to add.')
    parser_add_role.set_defaults(func=add_role)

    # user remove role
    parser_remove_role = user_subparsers.add_parser('remove-role', help='Remove a role from a user', description=remove_role.__doc__)
    parser_remove_role.add_argument('username', help='The username of the user.')
    parser_remove_role.add_argument('rolename', help='The role to remove.')
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
