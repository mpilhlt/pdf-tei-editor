# Command-Line Interface (CLI) Reference

This document provides the reference documentation for the PDF-TEI Editor command-line management tool.

## Overview

The `manage.py` script provides a command-line interface for managing users, groups, collections, and application configuration. All commands follow the pattern:

```bash
npm run manage <command> <subcommand> [options]
```

Or directly with Python:

```bash
python bin/manage.py <command> <subcommand> [options]
```

## Global Options

These options can be used with any command:

- `--db-path <path>`: Path to the database directory (default: `./data/db`)
- `--config-path <path>`: Path to the config directory (default: `./config`)

## User Management

### user list

Lists all users with their roles and group memberships.

```bash
npm run manage user list
```

**Output format**: `Fullname (username) [email]: roles | Groups: groups`

### user add

Adds a new user to the system.

```bash
npm run manage user add <username> [options]
```

**Options**:

- `--password <password>`: User password (prompted if not provided)
- `--fullname <name>`: Full name of the user
- `--email <email>`: Email address
- `--roles <roles>`: Comma-separated list of roles (e.g., "user,annotator")

**Example**:

```bash
npm run manage user add alice --password secret123 --fullname "Alice Smith" --email "alice@example.com" --roles "user,annotator"
```

### user remove

Removes a user from the system.

```bash
npm run manage user remove <username>
```

### user set

Sets a user property (fullname, username, or email).

```bash
npm run manage user set <username> <property> <value>
```

**Properties**: `fullname`, `username`, `email`

**Example**:

```bash
npm run manage user set alice email alice.smith@example.com
```

### user update-password

Updates a user's password.

```bash
npm run manage user update-password <username> [password]
```

If password is not provided, it will be prompted interactively.

### user add-role

Adds a role to a user. If no role is specified, lists available roles.

```bash
npm run manage user add-role <username> [rolename]
```

**Example**:

```bash
npm run manage user add-role alice reviewer
```

### user remove-role

Removes a role from a user. If no role is specified, lists available roles.

```bash
npm run manage user remove-role <username> [rolename]
```

### user add-group

Adds a group to a user. If no group is specified, lists available groups.

```bash
npm run manage user add-group <username> [groupid]
```

**Example**:

```bash
npm run manage user add-group alice editors
```

### user remove-group

Removes a group from a user. If no group is specified, lists available groups.

```bash
npm run manage user remove-group <username> [groupid]
```

## Group Management

### group list

Lists all groups with their collections.

```bash
npm run manage group list
```

**Output format**: `groupid: name (description) [Collections: collection1, collection2]`

### group add

Adds a new group to the system.

```bash
npm run manage group add <groupid> <name> [options]
```

**Options**:

- `--description <text>`: Description of the group

**Example**:

```bash
npm run manage group add editors "Editors Group" --description "Group for content editors"
```

### group remove

Removes a group from the system.

```bash
npm run manage group remove <groupid>
```

### group set

Sets a group property (id, name, or description).

```bash
npm run manage group set <groupid> <property> <value>
```

**Properties**: `id`, `name`, `description`

**Example**:

```bash
npm run manage group set editors description "Updated description"
```

### group add-collection

Adds a collection to a group. If no collection is specified, lists available collections.

```bash
npm run manage group add-collection <groupid> [collectionid]
```

**Example**:

```bash
npm run manage group add-collection editors manuscripts
```

### group remove-collection

Removes a collection from a group. If no collection is specified, lists available collections.

```bash
npm run manage group remove-collection <groupid> [collectionid]
```

## Collection Management

### collection list

Lists all collections.

```bash
npm run manage collection list
```

**Output format**: `collectionid: name (description)`

### collection add

Adds a new collection to the system.

```bash
npm run manage collection add <collectionid> <name> [options]
```

**Options**:

- `--description <text>`: Description of the collection

**Example**:

```bash
npm run manage collection add manuscripts "Manuscript Collection" --description "Historical manuscripts"
```

### collection remove

Removes a collection from the system.

```bash
npm run manage collection remove <collectionid>
```

### collection set

Sets a collection property (id, name, or description).

```bash
npm run manage collection set <collectionid> <property> <value>
```

**Properties**: `id`, `name`, `description`

**Example**:

```bash
npm run manage collection set manuscripts name "Medieval Manuscripts"
```

## Configuration Management

### config get

Gets a configuration value.

```bash
npm run manage config get <key> [options]
```

**Options**:

- `--default`: Read from config/config.json instead of data/db/config.json

**Example**:

```bash
npm run manage config get session.timeout
```

### config set

Sets a configuration value.

```bash
npm run manage config set <key> <value> [options]
```

**Options**:

- `--values <json-array>`: Set the values constraint for this key (JSON array)
- `--type <type>`: Set the type constraint for this key
- `--default`: Set in both db/config.json and config/config.json

**Note**: The value must be valid JSON.

**Examples**:

```bash
# Set a string value
npm run manage config set app.name '"My App"'

# Set a number value
npm run manage config set session.timeout 3600

# Set allowed values constraint
npm run manage config set mode --values '["dev","prod","test"]'

# Set type constraint
npm run manage config set session.timeout --type number
```

### config delete

Deletes a configuration key.

```bash
npm run manage config delete <key> [options]
```

**Options**:

- `--default`: Delete from both db/config.json and config/config.json

## Help Command

### help

Shows help for a specific command or general help.

```bash
npm run manage help [command]
```

**Examples**:

```bash
# General help
npm run manage help

# User management help
npm run manage help user

# Group management help
npm run manage help group
```

## Access Control Model

The system implements a three-level access control model:

```
User → Group → Collection
```

- **Users** belong to one or more **Groups**
- **Groups** have access to one or more **Collections**
- **Collections** contain documents

This model allows fine-grained access control where users can only access documents in collections that their groups have access to.

## Common Workflows

### Setting Up a New User with Access

```bash
# 1. Create the user
npm run manage user add bob --password secret --fullname "Bob Johnson"

# 2. Assign roles
npm run manage user add-role bob user
npm run manage user add-role bob annotator

# 3. Add user to group
npm run manage user add-group bob editors
```

### Creating a New Project Collection

```bash
# 1. Create the collection
npm run manage collection add project-x "Project X Documents" --description "Documents for Project X"

# 2. Create a group for the project
npm run manage group add project-x-team "Project X Team"

# 3. Give the group access to the collection
npm run manage group add-collection project-x-team project-x

# 4. Add users to the group
npm run manage user add-group alice project-x-team
npm run manage user add-group bob project-x-team
```

### Auditing Access

```bash
# List all users and their groups
npm run manage user list

# List all groups and their collections
npm run manage group list

# List all collections
npm run manage collection list
```

## Related Documentation

- [User Management](../user-management.md) - Detailed user management guide
- [Access Control](../access-control.md) - Access control concepts
- [Configuration](../configuration.md) - Application configuration
