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

## Database Management

### Run Migrations

Applies pending database migrations to update the schema or fix data integrity issues.

```bash
python bin/run-migration.py [options]
```

**Options**:

- `--db-path <path>`: Path to database file (default: data/db/metadata.db)
- `--dry-run`: Check which migrations would run without applying them
- `--skip-backup`: Skip database backup before migration (not recommended)

**Example**:

```bash
# Check pending migrations
python bin/run-migration.py --dry-run

# Run migrations (creates backup automatically)
python bin/run-migration.py

# Run on specific database
python bin/run-migration.py --db-path data/db/custom.db
```

**Notes**:

- Migrations run automatically when the application starts
- Use this script to manually apply migrations or check migration status
- A backup is created before each migration run (unless --skip-backup is used)
- Backups are saved as `{db_name}_backup_{timestamp}.db`

**Common migrations**:

- Migration 001: Update locks table for stable_id support
- Migration 002: Sync TEI file collections with their PDF files

See [docs/development/migrations.md](../development/migrations.md) for more information about the migration system.

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

## Development Commands

### dev:reset

Resets the application by moving the data directory and log files to trash.

```bash
npm run dev:reset
npm run dev:reset -- --restart  # Also restart the server
```

**Options**:

- `--restart`: Restart the development server after reset

**What it does**:

1. Prompts for confirmation before proceeding
2. Moves the entire `data` directory to trash (users, files, configuration)
3. Moves all files in the `log` directory to trash
4. Optionally restarts the development server with `--restart` flag

**Warning**: This action is destructive and will delete:

- All user accounts and sessions
- All uploaded files and their metadata
- All application configuration
- All log files

**Use cases**:

- Reset development environment to clean state
- Clear test data between development cycles
- Start fresh after configuration changes

**Output example**:

```
WARNING: This will move the 'data' directory and 'log' directory contents to trash.
This action will delete:
  - All user accounts and sessions
  - All uploaded files and their metadata
  - All application configuration
  - All log files

Are you sure you want to continue? (yes/no): yes
Moving /path/to/data to trash...
Data directory successfully moved to trash.
Moving 3 log file(s) to trash...
Log files successfully moved to trash.

Reset complete. Use 'npm run start:dev' to start the server with fresh configuration.
```

**With `--restart` flag**:

```
...
Moving 3 log file(s) to trash...
Log files successfully moved to trash.

Restarting development server...
Killing server process on port 8000 (PID: 12345)...
Starting FastAPI development server...
```

**Note**: Files are moved to the system trash/recycle bin and can be recovered if needed.

## Testing Commands

### test:changed

Runs tests intelligently based on changed files, using dependency analysis to determine which tests are affected.

```bash
# Run tests for changed files
npm run test:changed

# Check which tests would run without executing them
npm run test:changed -- --dry-run

# Output only test file names (one per line, nothing if no tests)
npm run test:changed -- --names-only

# Run tests for specific files
npm run test:changed -- app/src/plugins/filedata.js fastapi_app/routers/files.py
```

**Options**:

- `--all`: Run all tests regardless of changes
- `--dry-run`: Show which tests would run without executing them
- `--names-only`: Output only test file names (one per line), nothing if no tests need to run
- `--tap`: Output results in TAP format
- `--debug`: Enable debug logging
- `--browser <browsers>`: Browser(s) to use for E2E tests (comma-separated, default: chromium)

**What it does**:

1. Analyzes test files for `@testCovers` annotations and JavaScript import dependencies
2. Detects which files have changed (via git) or uses provided file list
3. Determines which tests are affected by the changes
4. Runs only the relevant tests (or all tests marked with `@testCovers *`)
5. Supports JavaScript unit tests, Python unit tests, API integration tests, and E2E tests

**Use cases**:

- Fast test iteration during development (only run affected tests)
- Pre-commit validation (automatically run by git hooks)
- CI/CD optimization (skip unnecessary test runs)
- Quick verification of which tests cover specific code

**Output modes**:

- Default: Runs tests and shows results
- `--dry-run`: Shows which tests would run with detailed information
- `--names-only`: Outputs only test file paths (useful for CI/CD scripts)

### test:container

Tests that the application container builds and starts correctly.

```bash
npm run test:container
```

**What it does**:

1. Builds the test container from the current codebase
2. Starts the container
3. Waits for the health check endpoint to respond
4. Displays container information (name, URL, health status)
5. Stops and removes the container

**Use cases**:

- Validate `Dockerfile` changes
- Test modifications to `docker/entrypoint-test.sh`
- Verify server startup configuration
- Quick validation before pushing container-related changes

**Output example**:

```
🧪 Testing container startup...

📦 Building and starting container...
[container build output...]

✅ Container started successfully!

📊 Container details:
   Name: pdf-tei-editor-test-1234567890
   URL: http://localhost:8000
   Health: http://localhost:8000/health

🧹 Cleaning up...

✅ Test completed successfully!
```

**Note**: This command rebuilds the container each time. For faster iterations during development, use `npm run container:start` to keep a container running.

## Batch Processing Commands

### batch-extract

Batch extracts metadata from PDF files in a directory using the HTTP API.

```bash
npm run batch-extract -- <directory> [options]
```

**Required Arguments**:

- `<directory>`: Directory containing PDF files to process

**Required Options**:

- `--extractor <id>`: Extractor ID to use for metadata extraction

**Optional Options**:

- `--collection <id>`: Collection ID to assign uploaded files to (default: directory basename)
- `--env <path>`: Path to .env file (default: ./.env)
- `--user <username>`: Username for authentication (default: from .env API_USER)
- `--password <password>`: Password for authentication (default: from .env API_PASSWORD)
- `--base-url <url>`: API base URL (default: from .env API_BASE_URL or http://localhost:8000)
- `--option <key=value>`: Extractor option (can be specified multiple times)
- `--recursive`: Recursively search subdirectories for PDFs

**Environment Variables** (in .env file):

```bash
API_USER=admin
API_PASSWORD=admin
API_BASE_URL=http://localhost:8000
```

**Examples**:

```bash
# Basic batch extract (uses directory basename as collection)
npm run batch-extract -- /path/to/manuscripts --extractor mock-extractor

# With explicit collection name
npm run batch-extract -- /path/to/pdfs --collection my_collection --extractor mock-extractor

# Recursive search with CLI credentials override
npm run batch-extract -- /path/to/pdfs \
  --collection my_collection \
  --extractor grobid-training \
  --user admin \
  --password secret \
  --recursive

# With custom extractor options
npm run batch-extract -- /path/to/pdfs \
  --collection my_collection \
  --extractor llamore-gemini \
  --option variant_id=v1 \
  --option doi=10.1234/test

# Using custom .env file
npm run batch-extract -- /path/to/pdfs \
  --env /path/to/custom.env \
  --extractor mock-extractor
```

**What it does**:

1. Loads API credentials from .env file or CLI arguments
2. Finds all PDF files in the specified directory (optionally recursive)
3. Authenticates with the API server
4. Creates the collection if it doesn't exist
5. Checks for files already processed in the collection (resume support)
6. For each PDF file not already in the collection:
   - Extracts DOI from filename if present (see DOI Filename Encoding below)
   - Uploads the file to the server
   - Triggers metadata extraction using the specified extractor
   - Passes extracted DOI to extractor automatically
   - Reports success or failure
7. Displays summary showing total, already processed, new, success, and failed counts

**DOI Filename Encoding**:

If PDF filenames contain DOIs, they will be automatically extracted and passed to the extractor. Encode DOIs in filenames by replacing "/" with "__" (double underscore).

Examples:
- `10.5771/2699-1284-2024-3-149.pdf` → `10.5771__2699-1284-2024-3-149.pdf`
- `10.1234/abcd.5678.pdf` → `10.1234__abcd.5678.pdf`

**Use cases**:

- Bulk import of PDF documents into a collection
- Automated metadata extraction for large document sets
- Integration with external workflows and scripts
- Batch processing of scanned documents

**Note**: If the specified collection does not exist, it will be created automatically.

### maintenance

Administrative maintenance commands for the PDF-TEI Editor.

```bash
npm run maintenance -- <command> [options]
```

**Global Options**:

- `--env <path>`: Path to .env file (default: ./.env)
- `--user <username>`: Username for authentication (default: from .env API_USER)
- `--password <password>`: Password for authentication (default: from .env API_PASSWORD)
- `--base-url <url>`: API base URL (default: from .env API_BASE_URL or http://localhost:8000)

**Environment Variables** (in .env file):

```bash
API_USER=admin
API_PASSWORD=admin
API_BASE_URL=http://localhost:8000
```

#### maintenance repopulate

Re-extracts fields from TEI documents and updates the database.

```bash
npm run maintenance -- repopulate [fields...]
```

**Arguments**:

- `[fields...]`: Optional list of fields to repopulate (default: all fields)

**Available Fields**:

- `status`: Revision status from `revisionDesc/change/@status`
- `last_revision`: Timestamp from `revisionDesc/change/@when`

**Examples**:

```bash
# Repopulate all fields
npm run maintenance -- repopulate

# Repopulate only the status field
npm run maintenance -- repopulate status

# Repopulate multiple specific fields
npm run maintenance -- repopulate status last_revision

# With custom credentials
npm run maintenance -- --user admin --password secret repopulate
```

**What it does**:

1. Authenticates with the API server (requires admin role)
2. For each specified field (or all fields):
   - Iterates through all TEI files in the database
   - Re-extracts the field value from the TEI XML
   - Updates the database with the extracted value
3. Reports statistics for each field (updated, skipped, errors)

**Use cases**:

- Refresh metadata after updating extraction logic
- Fix inconsistent data after schema changes
- Bulk update fields after manual TEI edits

**Output example**:

```
Base URL: http://localhost:8000
Fields: all

Logging in...
Login successful

Repopulating fields from TEI documents...

=== Results ===

status:
  Total files: 150
  Updated: 145
  Skipped (no value): 3
  Errors: 2

last_revision:
  Total files: 150
  Updated: 148
  Skipped (no value): 2
  Errors: 0

=== Summary ===
Success: No
Message: Repopulated 2 field(s): 293 updates, 2 errors
```

**Note**: This command requires admin privileges. Non-admin users will receive a 403 Forbidden error.

## Release Commands

### release:patch / release:minor / release:major

Creates a new release with automatic version bumping, testing, and git tagging.

```bash
npm run release:patch   # Bump patch version (0.7.0 -> 0.7.1)
npm run release:minor   # Bump minor version (0.7.0 -> 0.8.0)
npm run release:major   # Bump major version (0.7.0 -> 1.0.0)
```

**Options**:

- `--dry-run`: Test the release process without pushing changes
- `--skip-tests`: Skip test execution (not recommended)

**Examples**:

```bash
# Test release process without making changes
npm run release:minor -- --dry-run

# Create release and skip tests
npm run release:patch -- --skip-tests

# Combine options
npm run release:minor -- --dry-run --skip-tests
```

**What it does**:

1. Validates working directory is clean
2. Fetches latest changes from remote
3. Creates release branch if on main (for write-protected branches)
4. Runs full test suite (unless `--skip-tests`)
5. Regenerates API client if needed
6. Bumps version in `package.json` and creates git commit
7. Creates git tag (e.g., `v0.8.0`)
8. Pushes branch and tag to remote (unless `--dry-run`)
9. Attempts to create PR using GitHub CLI if available

**Release workflow for write-protected main branch**:

When running from the `main` branch, the script creates a release branch (e.g., `release/minor-1733320000`) and pushes it along with the tag. You then:

1. Create a PR from the release branch to main
2. Review and merge the PR
3. GitHub Actions will build and publish the release using the pushed tag

**Direct release workflow**:

When running from a feature branch, the script pushes directly to that branch with the tag, suitable for testing or when working on non-protected branches.

**Output example**:

```
🚀 Starting minor release process...

📍 Current branch: main
📦 Current version: 0.7.0

📥 Fetching latest changes from remote...

🔀 On main branch, creating release branch...
✅ Created and switched to branch: release/minor-1733320000

🧪 Running tests...
✅ All tests passed

🔄 Generating API client...

⬆️  Bumping minor version...
✅ Version bumped: 0.7.0 → 0.8.0

📤 Pushing changes to remote...

📋 Release branch pushed successfully!

📝 Next steps:
   1. Create a PR from release/minor-1733320000 to main
   2. Review and merge the PR
   3. The tag v0.8.0 has already been pushed
   4. GitHub Actions will build and publish the release

🎉 Release process complete!
```

## Related Documentation

- [User Management](../user-management.md) - Detailed user management guide
- [Access Control](../access-control.md) - Access control concepts
- [Configuration](../configuration.md) - Application configuration
- [Testing Guide](../code-assistant/testing-guide.md) - Complete testing documentation
