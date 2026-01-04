# Centralized Migration Runner

## Problem

The migration system had a design gap where:

1. **locks.db** had migration runner code in `locking.py` that ran migrations automatically on startup
2. **metadata.db** did NOT have automatic migration runner - it only created the base schema
3. This meant Migration 002 (which targets metadata.db) never ran automatically
4. Each new database would require duplicating migration runner boilerplate

## Solution

Created a centralized migration runner that can be easily integrated into any database initialization:

### New File: `fastapi_app/lib/migration_runner.py`

Single reusable function `run_migrations_if_needed()` that:
- Checks if migrations are needed
- Runs pending migrations
- Caches results per-process to avoid redundant checks
- Works with any SQLite database

### Updated Database Initialization

**metadata.db** ([database.py](../../fastapi_app/lib/database.py)):
- `DatabaseManager._ensure_db_exists()` now passes `db_path` to `initialize_database()`
- `initialize_database()` calls `run_migrations_if_needed()` after creating schema

**locks.db** ([locking.py](../../fastapi_app/lib/locking.py)):
- Simplified `init_locks_db()` to use `run_migrations_if_needed()`
- Removed custom migration detection logic
- Removed global `_migrations_run` flag (now handled by migration_runner)

## Benefits

1. **No More Duplication**: Single source of truth for migration runner logic
2. **Easy to Add New Databases**: Just call `run_migrations_if_needed()` in initialization
3. **Consistent Behavior**: All databases get migrations applied the same way
4. **Automatic on Startup**: Migrations run when the application starts
5. **Idempotent**: Safe to call multiple times, won't re-run migrations

## Usage Pattern

For any new database:

```python
def initialize_my_database(conn: sqlite3.Connection, logger=None, db_path=None) -> None:
    """Initialize database schema."""
    # Create tables
    cursor = conn.cursor()
    cursor.execute(CREATE_MY_TABLE)
    conn.commit()

    # Run migrations if db_path provided
    if db_path:
        from pathlib import Path
        from .migration_runner import run_migrations_if_needed
        from .migrations.versions import ALL_MIGRATIONS

        run_migrations_if_needed(
            db_path=Path(db_path),
            migrations=ALL_MIGRATIONS,
            logger=logger
        )
```

## Documentation

Created comprehensive guides:

- **[Adding New Databases](../../docs/development/adding-new-databases.md)** - Step-by-step guide with examples
- **[Migration Documentation](../../docs/development/migrations.md)** - Updated to reference centralized runner
- **[CLAUDE.md](../../CLAUDE.md)** - Added reminder to use centralized runner for new databases

## Testing

Verified that:
- ✓ New databases get migrations applied automatically
- ✓ Existing databases don't re-run migrations
- ✓ metadata.db now runs Migration 002 on startup
- ✓ locks.db continues to work with simplified code
- ✓ TEI files in grobid-batch-7 collection are correctly synchronized (10 PDFs, 10 TEIs)

## Files Changed

### New Files
- `fastapi_app/lib/migration_runner.py` - Centralized migration runner
- `docs/development/adding-new-databases.md` - Guide for adding new databases

### Modified Files
- `fastapi_app/lib/database.py` - Pass db_path to initialize_database
- `fastapi_app/lib/db_schema.py` - Call migration runner after schema creation
- `fastapi_app/lib/locking.py` - Simplified to use centralized runner
- `docs/development/migrations.md` - Updated documentation
- `CLAUDE.md` - Added reminder about centralized runner

## Migration Status

After this change, all databases now have migration history:

**metadata.db:**
- ✓ Migration 2: Sync TEI file collections with their PDF files

**locks.db:**
- ✓ Migration 1: Rename locks.file_hash to locks.file_id for stable_id support

## Future Work

This pattern makes it trivial to add new databases with automatic migration support. Just follow the guide in [docs/development/adding-new-databases.md](../../docs/development/adding-new-databases.md).
