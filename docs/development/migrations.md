# Database Migrations

This document describes the database migration infrastructure for managing schema changes in the PDF-TEI Editor.

## Overview

The migration system provides a robust, versioned approach to database schema evolution with:

- **Versioned migrations** - Sequential migration scripts with version numbers
- **Automatic backups** - Database is backed up before each migration
- **Transactional safety** - Migrations run in transactions with automatic rollback on failure
- **Idempotent operations** - Safe to run multiple times
- **Rollback support** - Can revert migrations if needed
- **Migration history** - Tracks which migrations have been applied

## Architecture

The migration infrastructure is located in `fastapi_app/lib/migrations/`:

```text
fastapi_app/lib/migrations/
├── __init__.py              # Public API exports
├── base.py                  # Migration base class
├── manager.py               # MigrationManager for running migrations
└── versions/                # Individual migration files
    ├── __init__.py          # Registry of all migrations
    └── m001_locks_file_id.py  # Example migration
```

## Creating a Migration

### 1. Create a Migration File

Create a new file in `fastapi_app/lib/migrations/versions/` with the naming pattern `mXXX_description.py`:

```python
"""
Migration XXX: Brief description

Detailed description of what this migration does and why.

Before: Description of old schema
After: Description of new schema
"""

import sqlite3
from ..base import Migration


class MigrationXXX_Description(Migration):
    """
    One-line summary of the migration.

    Details about the migration, what it changes, and any caveats.
    """

    @property
    def version(self) -> int:
        """Migration version number (must be unique and sequential)."""
        return XXX

    @property
    def description(self) -> str:
        """Human-readable description."""
        return "Brief description of what this migration does"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        """
        Optional: Check if migration can be applied.

        Returns False if migration is not applicable (already applied,
        prerequisites not met, etc.).

        Args:
            conn: SQLite connection

        Returns:
            True if migration should be applied, False to skip
        """
        # Example: Check if a column exists
        cursor = conn.execute("PRAGMA table_info(my_table)")
        columns = {row[1] for row in cursor.fetchall()}

        # Skip if already migrated
        if "new_column" in columns:
            self.logger.info("Migration already applied")
            return False

        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        """
        Apply the migration.

        This runs within a transaction - if it raises an exception,
        all changes will be rolled back automatically.

        Args:
            conn: SQLite connection (in transaction)

        Raises:
            Exception: If migration fails
        """
        self.logger.info("Applying migration XXX")

        # Example: Add a new column
        conn.execute("""
            ALTER TABLE my_table
            ADD COLUMN new_column TEXT
        """)

        self.logger.info("Migration XXX complete")

    def downgrade(self, conn: sqlite3.Connection) -> None:
        """
        Revert the migration.

        This runs within a transaction - if it raises an exception,
        all changes will be rolled back automatically.

        Args:
            conn: SQLite connection (in transaction)

        Raises:
            Exception: If rollback fails
        """
        self.logger.info("Reverting migration XXX")

        # Example: Remove the column (SQLite requires table recreation)
        conn.execute("""
            CREATE TABLE my_table_new AS
            SELECT col1, col2 FROM my_table
        """)
        conn.execute("DROP TABLE my_table")
        conn.execute("ALTER TABLE my_table_new RENAME TO my_table")

        self.logger.info("Migration XXX reverted")
```

### 2. Register the Migration

Add your migration to `fastapi_app/lib/migrations/versions/__init__.py` in the appropriate database-specific list:

```python
from .m001_locks_file_id import Migration001LocksFileId
from .mXXX_description import MigrationXXX_Description

# Migrations by target database
LOCKS_MIGRATIONS = [
    Migration001LocksFileId,
]

METADATA_MIGRATIONS = [
    MigrationXXX_Description,  # Add your migration to the correct list
]

# All migrations in order (for tools that need the complete list)
ALL_MIGRATIONS = [
    Migration001LocksFileId,
    MigrationXXX_Description,
]
```

**Important:** Add migrations to the database-specific list (`LOCKS_MIGRATIONS` or `METADATA_MIGRATIONS`) that matches their target database. This prevents unnecessary migration checks and log noise.

### 3. Test the Migration

Create comprehensive tests in `fastapi_app/lib/migrations/tests/`:

**IMPORTANT:** Migration tests should NOT be part of the main test suite. They are for manual verification only and should be placed in the migration directory structure.

```python
"""
Unit tests for migration XXX.

@testCovers fastapi_app/lib/migrations/versions/mXXX_description.py
"""

import logging
import unittest
import sqlite3
import tempfile
from pathlib import Path

from fastapi_app.lib.core.migrations import MigrationManager
from fastapi_app.lib.migrations.versions.mXXX_description import MigrationXXX_Description


class TestMigrationXXX(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = Path(self.temp_dir) / "test.db"
        # Create logger configured to suppress expected warnings
        self.logger = logging.getLogger("test_migration_XXX")
        self.logger.setLevel(logging.ERROR)  # Suppress INFO and WARNING

    def tearDown(self):
        import shutil
        if Path(self.temp_dir).exists():
            shutil.rmtree(self.temp_dir)

    def test_migration_applies_successfully(self):
        # Create database with old schema
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("CREATE TABLE my_table (col1 TEXT, col2 TEXT)")
            conn.commit()

        # Run migration
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(MigrationXXX_Description(self.logger))
        applied = manager.run_migrations(skip_backup=True)

        self.assertEqual(applied, 1)

        # Verify new schema
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("PRAGMA table_info(my_table)")
            columns = {row[1] for row in cursor.fetchall()}
            self.assertIn("new_column", columns)

    def test_migration_is_idempotent(self):
        # Run migration twice
        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(MigrationXXX_Description(self.logger))

        applied1 = manager.run_migrations(skip_backup=True)
        applied2 = manager.run_migrations(skip_backup=True)

        self.assertEqual(applied1, 1)
        self.assertEqual(applied2, 0)  # Not re-applied
```

Save this file as `fastapi_app/lib/migrations/tests/test_migration_XXX.py`.

To run the migration tests manually:

```bash
# Run specific migration test
uv run python -m pytest fastapi_app/lib/migrations/tests/test_migration_XXX.py -v

# Run all migration tests
uv run python -m pytest fastapi_app/lib/migrations/tests/ -v
```

## Running Migrations

### Automatic Migration (Recommended)

Migrations run automatically when the application starts for all databases. This is handled by the centralized migration runner.

If you're adding a new database, see [Adding New Databases](adding-new-databases.md) for how to integrate automatic migrations.

### Manual Migration (CLI)

Use the `bin/run-migration.py` script to run migrations manually:

```bash
# Run all pending migrations
uv run python bin/run-migration.py data/db/metadata.db

# Show migration history
uv run python bin/run-migration.py data/db/metadata.db --history
```

### Manual Migration (Python)

For advanced use cases, you can run migrations programmatically using the centralized runner:

```python
from pathlib import Path
from fastapi_app.lib.core.migration_runner import run_migrations_if_needed
from fastapi_app.lib.migrations.versions import METADATA_MIGRATIONS
import logging

logger = logging.getLogger(__name__)
db_path = Path("data/db/metadata.db")

# Run migrations (idempotent - safe to call multiple times)
applied = run_migrations_if_needed(
    db_path=db_path,
    migrations=METADATA_MIGRATIONS,  # Use database-specific migration list
    logger=logger
)
print(f"Applied {applied} migrations")
```

Or use the MigrationManager directly for more control:

```python
from pathlib import Path
from fastapi_app.lib.core.migrations import MigrationManager
from fastapi_app.lib.migrations.versions import METADATA_MIGRATIONS
import logging

logger = logging.getLogger(__name__)
db_path = Path("data/db/metadata.db")

# Initialize manager
manager = MigrationManager(db_path, logger)

# Register migrations for this database
for migration_class in METADATA_MIGRATIONS:
    manager.register_migration(migration_class(logger))

# Run all pending migrations
applied = manager.run_migrations()
print(f"Applied {applied} migrations")

# View migration history
history = manager.get_migration_history()
for record in history:
    print(f"Version {record['version']}: {record['description']}")
    print(f"  Applied: {record['applied_at']}")
    print(f"  Success: {record['success']}")
```

## Migration Best Practices

### DO

1. **Use sequential version numbers** - Start from 1, increment by 1
2. **Make migrations idempotent** - Use `check_can_apply()` to skip if already applied
3. **Use `IF NOT EXISTS` clauses** - For CREATE TABLE, CREATE INDEX, etc.
4. **Test thoroughly** - Write unit tests for upgrade and downgrade
5. **Document changes** - Include clear descriptions and comments
6. **Keep migrations focused** - One logical change per migration
7. **Use transactions** - Migrations automatically run in transactions
8. **Handle data migration** - If changing data format, include data transformation

### DON'T

1. **Don't modify old migrations** - Once deployed, migrations are immutable
2. **Don't skip version numbers** - Keep them sequential
3. **Don't delete migrations** - They're part of the schema history
4. **Don't assume order** - Don't rely on migrations running in a specific environment
5. **Don't make breaking changes without migration** - Always provide upgrade path

### SQLite-Specific Considerations

SQLite has some limitations compared to other databases:

1. **No ALTER TABLE DROP COLUMN** - Must recreate table:

   ```python
   # Create new table without column
   conn.execute("CREATE TABLE new_table AS SELECT col1, col2 FROM old_table")
   conn.execute("DROP TABLE old_table")
   conn.execute("ALTER TABLE new_table RENAME TO old_table")
   # Recreate indexes
   ```

2. **No ALTER TABLE RENAME COLUMN** (older SQLite) - Must recreate table:

   ```python
   # Create new table with new column name
   conn.execute("CREATE TABLE new_table (new_name TEXT, other_col TEXT)")
   conn.execute("INSERT INTO new_table SELECT old_name, other_col FROM old_table")
   conn.execute("DROP TABLE old_table")
   conn.execute("ALTER TABLE new_table RENAME TO old_table")
   ```

3. **Foreign key constraints** - Disabled by default, must enable:

   ```python
   conn.execute("PRAGMA foreign_keys = ON")
   ```

## Example: Locks Table Migration

The first migration (Migration 001) demonstrates a complete schema change:

**File:** `fastapi_app/lib/migrations/versions/m001_locks_file_id.py`

**What it does:**

- Renames `file_hash` column to `file_id` in locks table
- Changes locks from using content hashes to stable IDs
- Clears old locks (acceptable since they expire in 90 seconds)

**Key features:**

- Uses `check_can_apply()` to skip if already migrated
- Creates new table, drops old one, renames new one (SQLite pattern)
- Includes both upgrade and downgrade paths
- Comprehensive logging at each step

See the actual file for complete implementation details.

## Troubleshooting

### Migration Fails

If a migration fails:

1. **Check the logs** - Migration errors are logged with full stack traces
2. **Review the backup** - A backup is created before each migration run
3. **Check migration history** - Failed migrations are recorded with `success=0`
4. **Fix and retry** - Fix the migration code and restart the application

### Restore from Backup

Backups are created in the same directory as the database:

```bash
# Backups are named: {db_name}_backup_{timestamp}.db
ls data/db/locks_backup_*.db

# To restore:
cp data/db/locks_backup_20231219_120000.db data/db/locks.db
```

### Manual Rollback

To rollback a migration manually:

```python
from fastapi_app.lib.core.migrations import MigrationManager

manager = MigrationManager(db_path, logger)
# Register migrations...

# Rollback to version 1 (removes migrations 2, 3, etc.)
rolled_back = manager.rollback_migration(target_version=1)
print(f"Rolled back {rolled_back} migrations")
```

### Clear Migration History

To reset migration history (destructive - use with caution):

```python
import sqlite3

with sqlite3.connect("data/db/locks.db") as conn:
    conn.execute("DROP TABLE IF EXISTS migration_history")
    conn.commit()
```

## Migration Workflow

1. **Development:**
   - Create migration file
   - Write upgrade and downgrade methods
   - Add to appropriate database-specific migration list (`LOCKS_MIGRATIONS` or `METADATA_MIGRATIONS`) AND `ALL_MIGRATIONS`
   - Write tests
   - Test locally

2. **Testing:**
   - Run unit tests
   - Test on development database
   - Verify rollback works
   - Test with existing data

3. **Deployment:**
   - Commit migration to repository
   - Migration runs automatically on server startup
   - Monitor logs for successful application
   - Keep backup available for 30 days

4. **Post-Deployment:**
   - Verify migration applied successfully
   - Monitor application for issues
   - Keep rollback plan ready

## Data Migrations vs. Schema Migrations

This document describes **database schema migrations** - versioned changes to database structure (tables, columns, indexes).

**Data migrations** are different - they update file contents or data format without changing database schema. Data migrations:

- Live in `bin/` directory (not `fastapi_app/lib/migrations/versions/`)
- Run manually via command line (not automatically on startup)
- Update file contents in content-addressed storage
- Don't use the `Migration` base class or `MigrationManager`
- May change content hashes, requiring database record updates to point to new hashes

### Available Data Migrations

**TEI biblStruct Migration** (`bin/migrate-tei-biblstruct.py`)

Retrofits existing TEI documents with structured `biblStruct` elements in `sourceDesc` for machine-parsable journal metadata.

```bash
# Test on limited dataset
uv run python bin/migrate-tei-biblstruct.py --dry-run --limit 10

# Run full migration
uv run python bin/migrate-tei-biblstruct.py

# Force overwrite existing biblStruct (regenerate from metadata)
uv run python bin/migrate-tei-biblstruct.py --force

# Verbose logging
uv run python bin/migrate-tei-biblstruct.py -v
```

Features:

- Idempotent - safe to run multiple times (skips already-migrated files)
- Force mode (`--force`) - overwrites existing biblStruct elements with regenerated versions
- Extracts metadata from existing teiHeader elements
- Updates content-addressed storage with new file hashes
- Preserves all file metadata (stable_id, label, collections)
- Dry-run mode for testing
- Detailed progress logging

See implementation plan at `.claude/plans/generic-drifting-origami.md` for technical details.

## Future Enhancements

Potential improvements to the migration system:

- Support for multiple databases (metadata.db, locks.db, etc.)
- Migration dry-run mode
- Better conflict detection for concurrent migrations
- Schema version tracking in application
- Migration performance metrics
- Web UI for migration management
