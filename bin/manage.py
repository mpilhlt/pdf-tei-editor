#!/usr/bin/env python3
import argparse
import json
import hashlib
import os
from pathlib import Path
import getpass

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
    project_root = Path(__file__).resolve().parent.parent
    db_dir = project_root / 'db'
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
        "roles": ["user"],
        "passwd_hash": passwd_hash,
        "session_id": None
    })

    save_users_data(users_file, users_data)
    print(f"User '{args.username}' added successfully.")

def remove_user(args):
    """Removes a user from the users.json file."""
    project_root = Path(__file__).resolve().parent.parent
    db_dir = project_root / 'db'
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
    project_root = Path(__file__).resolve().parent.parent
    db_dir = project_root / 'db'
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
    project_root = Path(__file__).resolve().parent.parent
    db_dir = project_root / 'db'
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
    project_root = Path(__file__).resolve().parent.parent
    db_dir = project_root / 'db'
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
    """Lists all users in the format 'Fullname (username): Role1, Role2'."""
    project_root = Path(__file__).resolve().parent.parent
    db_dir = project_root / 'db'
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
        roles = ', '.join(user.get('roles', []))
        print(f"{fullname} ({username}): {roles}")

def set_user_property(args):
    """Sets a scalar, unencrypted property for a user."""
    project_root = Path(__file__).resolve().parent.parent
    db_dir = project_root / 'db'
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

if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description="A command-line tool to manage the PDF-TEI-Editor application.",
        epilog="Use 'manage.py <command> --help' for more information on a specific command.",
        formatter_class=argparse.RawTextHelpFormatter)
    
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
    parser_add.set_defaults(func=add_user)

    # user remove
    parser_remove = user_subparsers.add_parser('remove', help='Remove a user', description=remove_user.__doc__)
    parser_remove.add_argument('username', help='The username of the user to remove.')
    parser_remove.set_defaults(func=remove_user)

    # user set
    parser_set = user_subparsers.add_parser('set', help='Set a user property.', description=set_user_property.__doc__)
    parser_set.add_argument('username', help='The username of the user to update.')
    parser_set.add_argument('property', help='The property to set.', choices=['fullname', 'username'])
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

    # --- Help command ---
    all_subparsers = {'user': user_parser}
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
        else:
             parser.print_help()
