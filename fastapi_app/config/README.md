# FastAPI Configuration Defaults

This directory contains default configuration files that are copied to `fastapi_app/db/` on application startup if they don't exist.

## Pattern

This follows the same pattern as the Flask server (`config/` → `db/`):

1. **Default files** are stored here in version control
2. **Runtime files** are created in `db/` from these defaults
3. **Database files** in `db/` are **never committed** to git (see `.gitignore`)

## Files

- **config.json** - Application configuration (schema paths, server settings, etc.)
- **users.json** - Default user accounts (admin, annotator, reviewer)
- **prompt.json** - Default system prompts for LLM extractors

## Startup Behavior

On application startup (`fastapi_app/main.py`):

1. JSON files from `config/` are copied to `db/` if they don't exist
2. Missing keys in `db/config.json` are merged from `config/config.json`
3. SQLite databases (`sessions.db`, `locks.db`, `metadata.db`) are created on demand

This ensures:
- Clean separation between defaults (versioned) and runtime state (not versioned)
- Tests can start with clean state by deleting `db/` contents
- Configuration updates don't overwrite user customizations
- New installations get sensible defaults automatically

## Testing

For tests that need clean state:

```python
from fastapi_app.lib.db_init import clean_db_directory, initialize_db_from_config
from pathlib import Path

# Clean and reinitialize
clean_db_directory(Path("fastapi_app/db"))
initialize_db_from_config(
    Path("fastapi_app/config"),
    Path("fastapi_app/db")
)
```

## User Accounts

Default users in `users.json`:

- **admin** / password: `admin` - Full administrative access
- **annotator** / password: `annotator` - Can create/edit versions
- **reviewer** / password: `reviewer` - Can create/edit gold standard files

**Important**: Change these passwords in production by editing `db/users.json` (not this file).

## Modifying Defaults

To change default configuration:

1. Edit files in this directory (`config/`)
2. Commit changes to version control
3. New installations will get the updated defaults
4. Existing installations: Delete `db/<file>` to get new defaults, or manually merge changes

## See Also

- `fastapi_app/lib/db_init.py` - Configuration initialization logic
- `fastapi_app/main.py` - Startup lifecycle
- `.gitignore` - Database files exclusion
