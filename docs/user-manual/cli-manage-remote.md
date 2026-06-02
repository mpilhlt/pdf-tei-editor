# CLI for Access Control Management and Application Configuration - `manage-remote.js`

## Overview

The `manage-remote.js` script provides a command-line interface for managing [users](#user-management), [groups](#group-management), [collections](#collection-management), and [application configuration](#configuration-management) via the HTTP API. This works with both local and remote instances.

**Note**: Make sure to configure your instance's [Access Control Mode](./access-control.md) to a mode that fits your use case.

```bash
npm run manage-remote -- <command> <subcommand> [options]
```

Or directly with Node.js:

```bash
node bin/manage-remote.js <command> <subcommand> [options]
```

## Global Options

| Option | Description | Default |
|--------|-------------|---------|
| `--env <path>` | Path to .env file | `./.env` |
| `--user <username>` | Username for authentication | from `API_USER` in .env |
| `--password <password>` | Password for authentication | from `API_PASSWORD` in .env |
| `--base-url <url>` | API base URL | from `API_BASE_URL` in .env or `http://localhost:8000` |

## Environment Variables

Configure these in your `.env` file:

```bash
API_USER=admin
API_PASSWORD=admin
API_BASE_URL=http://localhost:8000
```

## User Management

```bash
npm run manage-remote -- user <subcommand> [options]
```

| Command | Description |
|---------|-------------|
| `user list` | List all users with roles and groups |
| `user get <username>` | Get details for a specific user |
| `user add <username> [options]` | Add a new user |
| `user remove <username>` | Remove a user |
| `user update <username> [options]` | Update user properties |
| `user add-role <username> <role>` | Add a role to a user |
| `user remove-role <username> <role>` | Remove a role from a user |
| `user add-group <username> <group>` | Add a user to a group |
| `user remove-group <username> <group>` | Remove a user from a group |

### user add Options

| Option | Description |
|--------|-------------|
| `--password <password>` | User password (prompted if not provided) |
| `--fullname <name>` | Full name of the user |
| `--email <email>` | Email address |
| `--roles <roles>` | Comma-separated list of roles |
| `--groups <groups>` | Comma-separated list of groups |

### user update Options

| Option | Description |
|--------|-------------|
| `--password <password>` | New password |
| `--fullname <name>` | New full name |
| `--email <email>` | New email address |

### Examples

```bash
# List all users
npm run manage-remote -- user list

# Add a user with roles
npm run manage-remote -- user add alice --password secret123 --fullname "Alice Smith" --roles "user,annotator"

# Add a role to existing user
npm run manage-remote -- user add-role alice reviewer

# Update user email
npm run manage-remote -- user update alice --email "alice.new@example.com"
```

## Group Management

```bash
npm run manage-remote -- group <subcommand> [options]
```

| Command | Description |
|---------|-------------|
| `group list` | List all groups with collections |
| `group get <group-id>` | Get details for a specific group |
| `group add <group-id> <name> [options]` | Add a new group |
| `group remove <group-id>` | Remove a group |
| `group update <group-id> [options]` | Update group properties |
| `group add-collection <group-id> <collection-id>` | Add a collection to a group |
| `group remove-collection <group-id> <collection-id>` | Remove a collection from a group |

### group add/update Options

| Option | Description |
|--------|-------------|
| `--description <text>` | Group description |
| `--name <name>` | Group name (update only) |

### Examples

```bash
# Create a group
npm run manage-remote -- group add editors "Editors Group" --description "Group for content editors"

# Add collection access to group
npm run manage-remote -- group add-collection editors manuscripts
```

## Collection Management

```bash
npm run manage-remote -- collection <subcommand> [options]
```

| Command | Description |
|---------|-------------|
| `collection list` | List all collections |
| `collection get <collection-id>` | Get details for a specific collection |
| `collection add <collection-id> <name> [options]` | Add a new collection |
| `collection remove <collection-id>` | Remove a collection |
| `collection update <collection-id> [options]` | Update collection properties |
| `collection files <collection-id>` | List files in a collection |

### collection add/update Options

| Option | Description |
|--------|-------------|
| `--description <text>` | Collection description |
| `--name <name>` | Collection name (update only) |

### Examples

```bash
# Create a collection
npm run manage-remote -- collection add manuscripts "Manuscript Collection" --description "Historical manuscripts"

# List files in collection
npm run manage-remote -- collection files manuscripts
```

## Role Management

```bash
npm run manage-remote -- role <subcommand>
```

| Command | Description |
|---------|-------------|
| `role list` | List all available roles |
| `role get <role-id>` | Get details for a specific role |

## Configuration Management

```bash
npm run manage-remote -- config <subcommand>
```

| Command | Description |
|---------|-------------|
| `config list` | List all configuration values |
| `config get <key>` | Get a configuration value |
| `config set <key> <json-value>` | Set a configuration value (value must be valid JSON) |

### Examples

```bash
# Get a config value
npm run manage-remote -- config get session.timeout

# Set a string value
npm run manage-remote -- config set app.name '"My App"'

# Set a number value
npm run manage-remote -- config set session.timeout 3600
```

## Maintenance Mode

```bash
npm run manage-remote -- maintenance <subcommand>
```

Requires admin privileges. Broadcasts commands to all connected browser clients via SSE.

| Command | Description |
|---------|-------------|
| `maintenance on [--message <text>]` | Show a blocking spinner on all clients (default: "System maintenance in progress, please wait...") |
| `maintenance off [--message <text>]` | Remove the spinner and resume normal operation. If `--message` is given, show it in an info dialog |
| `maintenance reload` | Force all clients to reload the page |

When maintenance mode is active, the heartbeat mechanism is paused and the UI is blocked.

### Examples

```bash
# Block all clients with default message
npm run manage-remote -- maintenance on

# Block all clients with custom message
npm run manage-remote -- maintenance on --message "Upgrading to v2.0, back in 5 minutes"

# Unblock after maintenance is done
npm run manage-remote -- maintenance off

# Unblock with a message shown in an info dialog
npm run manage-remote -- maintenance off --message "Maintenance complete. Please check your work."

# Force all clients to reload (e.g. after deploying a frontend update)
npm run manage-remote -- maintenance reload
```

## Diagnostic Commands

```bash
npm run manage-remote -- diagnostic <subcommand>
```

| Command | Description |
|---------|-------------|
| `diagnostic access create` | Create test users `reviewer` and `annotator` (password = username) |
| `diagnostic access remove` | Remove the test users |

These commands are useful for testing access control without creating full user accounts.

## Common Workflows

### Setting Up a New User with Access

```bash
# 1. Create the user
npm run manage-remote -- user add bob --password secret --fullname "Bob Johnson"

# 2. Assign roles
npm run manage-remote -- user add-role bob user
npm run manage-remote -- user add-role bob annotator

# 3. Add user to group
npm run manage-remote -- user add-group bob editors
```

### Creating a New Project Collection

```bash
# 1. Create the collection
npm run manage-remote -- collection add project-x "Project X Documents" --description "Documents for Project X"

# 2. Create a group for the project
npm run manage-remote -- group add project-x-team "Project X Team"

# 3. Give the group access to the collection
npm run manage-remote -- group add-collection project-x-team project-x

# 4. Add users to the group
npm run manage-remote -- user add-group alice project-x-team
npm run manage-remote -- user add-group bob project-x-team
```

### Auditing Access

```bash
# List all users and their groups
npm run manage-remote -- user list

# List all groups and their collections
npm run manage-remote -- group list

# List all collections
npm run manage-remote -- collection list
```
