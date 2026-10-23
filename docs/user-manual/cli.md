# Command-Line Interface (CLI) Reference

This document provides the reference documentation for the PDF-TEI Editor command-line management tools.

## Access Control management and Application Configuration

The `manage-remote.js` script provides a command-line interface for managing users, groups, collections, and application configuration via the HTTP API. This works with both local and remote instances. see the dedication documentation on [CLI for Access Control Management and Application Configuration](./cli-manage-remote.md).

## User API Keys

Extractors and plugins that call services billed to the user (e.g. Claude) use the user's own API key. Users enter their keys in the web interface (user menu > API Keys, or in the prompt that appears when a key is missing); the keys are stored Fernet-encrypted in `data/db/secrets.db`. The "Remove all keys" button in the API Keys dialog removes all keys of the current user at once (after a confirmation), including keys of services that are no longer installed. `bin/user-secrets.py` manages the same store from the command line, e.g. for administrators or for agents that need a key in a script:

```bash
uv run python bin/user-secrets.py list --user alice                # services with a stored key, no values
uv run python bin/user-secrets.py set anthropic --user alice       # hidden prompt
echo "$KEY" | uv run python bin/user-secrets.py set anthropic --user alice --stdin
uv run python bin/user-secrets.py delete anthropic --user alice

# Keep a key in a variable without printing it: get/export write the value only if stdout is captured
KEY=$(uv run python bin/user-secrets.py get anthropic --user alice --prompt)
eval "$(uv run python bin/user-secrets.py export anthropic --user alice --env ANTHROPIC_API_KEY)"
```

`--prompt` asks for a missing key on the controlling terminal (hidden input), stores it and returns it; without a terminal the command fails. `get` and `export` refuse to write to a terminal. `--user` defaults to `$PTE_SECRETS_USER`.

The encryption key is read from `SECRETS_ENCRYPTION_KEY` (generate one with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`). Without it, a key is generated once into `data/db/secrets.key` (mode 0600), which protects against a leaked database or backup but not against access to the data directory; production deployments should set the variable. Losing the key makes stored keys unreadable, and users have to enter them again.

## Database Management

### Run Migrations

Applies pending database migrations to update the schema or fix data integrity issues.

```bash
python bin/migrations/run-migration.py [options]
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

Releases are automated. Merging a `devel -> main` PR (as a merge commit) triggers
[`semantic-release`](https://github.com/semantic-release/semantic-release), which
bumps the version, updates `CHANGELOG.md`, creates the GitHub Release, and builds
and pushes the Docker image. There is no local release command.

To preview what the next release would be:

```bash
GH_TOKEN=$(gh auth token) npx semantic-release --dry-run --no-ci --branches "$(git branch --show-current)"
```


## Related Documentation

- [User Management](../user-management.md) - Detailed user management guide
- [Access Control](../access-control.md) - Access control concepts
- [Configuration](../configuration.md) - Application configuration
- [Testing Guide](../code-assistant/testing-guide.md) - Complete testing documentation
