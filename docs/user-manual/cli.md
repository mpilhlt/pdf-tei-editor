# Command-Line Interface (CLI) Reference

This document provides the reference documentation for the PDF-TEI Editor command-line management tools.

## Access Control management and Application Configuration

The `manage-remote.js` script provides a command-line interface for managing users, groups, collections, and application configuration via the HTTP API. This works with both local and remote instances. see the dedication documentation on [CLI for Access Control Management and Application Configuration](./cli-manage-remote.md).

## Database Management

### Run Migrations

Applies pending database migrations to update the schema or fix data integrity issues.

```bash
python bin/run-migration.py [options]
```

| Option | Description |
|--------|-------------|
| `--db-path <path>` | Path to database file (default: data/db/metadata.db) |
| `--dry-run` | Check which migrations would run without applying them |
| `--skip-backup` | Skip database backup before migration (not recommended) |

See [docs/development/migrations.md](../development/migrations.md) for more information about the migration system.

## Development Commands

### dev:reset

Resets the application by moving the data directory and log files to trash.

```bash
npm run dev:reset
npm run dev:reset -- --restart  # Also restart the server
```

**Warning**: This action is destructive and will delete all user accounts, uploaded files, configuration, and log files.

## Testing Commands

### test:changed

Runs tests intelligently based on changed files, using dependency analysis.

```bash
npm run test:changed              # Run tests for changed files
npm run test:changed -- --dry-run # Check which tests would run
npm run test:changed -- --all     # Run all tests
```

### test:e2e:xmleditor-browsers

Runs the `xmlTagSync` CodeMirror extension tests in all three browser engines (Chromium, Firefox, WebKit) via Playwright. Uses an isolated harness page — no application login or state required.

```bash
npm run test:e2e:xmleditor-browsers

# Single browser for faster iteration
node tests/e2e-runner.js tests/e2e/tests/xmleditor-cross-browser.spec.js --browser firefox

# Headed mode to observe behaviour
node tests/e2e-runner.js tests/e2e/tests/xmleditor-cross-browser.spec.js --browser chromium --headed
```

### test:container

Tests that the application container builds and starts correctly.

```bash
npm run test:container
```

## Batch Processing Commands

### batch-extract

Batch extracts metadata from PDF files in a directory using the HTTP API.

```bash
npm run batch-extract -- <directory> --extractor <id> [options]
```

| Option | Description |
|--------|-------------|
| `--extractor <id>` | Extractor ID (required) |
| `--collection <id>` | Collection ID (default: directory basename) |
| `--recursive` | Search subdirectories |
| `--option <key=value>` | Extractor option (repeatable) |

### manage-remote maintenance repopulate

Re-extracts fields from TEI documents and updates the database.

```bash
npm run manage-remote -- maintenance repopulate [fields...]
```

Available fields: `status`, `last_revision`

## Release Commands

| Command | Description |
|---------|-------------|
| `npm run release:patch` | Bump patch version (0.7.0 → 0.7.1) |
| `npm run release:minor` | Bump minor version (0.7.0 → 0.8.0) |
| `npm run release:major` | Bump major version (0.7.0 → 1.0.0) |

Options: `--dry-run`, `--skip-tests`


## Related Documentation

- [User Management](../user-management.md) - Detailed user management guide
- [Access Control](../access-control.md) - Access control concepts
- [Configuration](../configuration.md) - Application configuration
- [Testing Guide](../code-assistant/testing-guide.md) - Complete testing documentation
