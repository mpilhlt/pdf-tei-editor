# Local user management CLI

You can manage users locally using the `manage.py` command-line interface. 

> **Deprecation Notice**: The `bin/manage.py` script is deprecated and will be removed in a future version. Use `manage-remote.js` instead, which works with both local and remote instances via the HTTP API.

Usage:

```bash
npm run manage <command> <subcommand> [options]
# or call the script directly
python bin/manage.py <command> <subcommand> [options]
```

### Basic User Operations

```bash
# List all users
npm run manage user list

# Add a new user
npm run manage user add <username> --password <password> --fullname "<Full Name>" --email "<email>"

# Remove a user
npm run manage user remove <username>

# Update a user's password
npm run manage user update-password <username> --password <new_password>

# Set a user property (fullname, username, email)
npm run manage user set <username> <property> <value>
```

### Role Management

```bash
# Add a role to a user
npm run manage user add-role <username> <rolename>

# Remove a role from a user
npm run manage user remove-role <username> <rolename>
```

### Group Management

The system supports group-based access control for organizing users and managing access to collections:

```bash
# Add a group to a user
npm run manage user add-group <username> <groupid>

# Remove a group from a user
npm run manage user remove-group <username> <groupid>

# List all groups
npm run manage group list

# List all collections
npm run manage collection list
```

For comprehensive CLI documentation including group and collection management, see the [Development Commands](../code-assistant/development-commands.md).

### Example: Setting Up a New Admin User

```bash
# Remove the default admin user (recommended for security)
npm run manage user remove admin

# Add your own admin user
npm run manage user add myusername --password myuserpass --fullname "Full Name" --email "user@example.com"

# Grant admin privileges
npm run manage user add-role myusername admin
```

### Help and Documentation

```bash
# General help
npm run manage help

# User management specific help
npm run manage help user
```

