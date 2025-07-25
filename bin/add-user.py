#!/usr/bin/env python3
import argparse
import json
import hashlib
import os
from pathlib import Path

def add_user(username, password, fullname, roles):
    """Adds a new user to the users.json file."""
    project_root = Path(__file__).resolve().parent.parent
    data_root = project_root / 'data'
    users_file = data_root / 'users.json'

    if not users_file.exists():
        print(f"Error: {users_file} not found. Please start the application first to create it.")
        return

    with open(users_file, 'r+', encoding='utf-8') as f:
        try:
            users_data = json.load(f)
        except json.JSONDecodeError:
            users_data = []

        # Check if user already exists
        if any(user.get('username') == username for user in users_data):
            print(f"Error: User '{username}' already exists.")
            return

        # Hash the password
        passwd_hash = hashlib.sha256(password.encode('utf-8')).hexdigest()

        # Add new user
        users_data.append({
            "username": username,
            "fullname": fullname,
            "roles": roles,
            "passwd_hash": passwd_hash,
            "session_id": None
        })

        f.seek(0)
        json.dump(users_data, f, indent=2)
        f.truncate()
        print(f"User '{username}' added successfully.")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Add a new user to the application.")
    parser.add_argument("username", help="The username of the new user.")
    parser.add_argument("password", help="The password for the new user.")
    parser.add_argument("--fullname", help="The full name of the user.", default="")
    parser.add_argument("--roles", nargs='+', help="A list of roles for the user.", default=["user"])
    args = parser.parse_args()

    add_user(args.username, args.password, args.fullname, args.roles)
