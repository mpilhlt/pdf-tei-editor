# Adding New Databases

This guide explains how to add a new SQLite database to the application with automatic migration support.

## Overview

The application uses a centralized migration runner that automatically runs migrations for any database during initialization. This ensures:

- All databases get migrations applied automatically on startup
- No need to duplicate migration runner code
- Consistent migration behavior across all databases
- Easy to add new databases with migration support

## Quick Start

To add a new database with automatic migration support:

1. **Create your database initialization function** that creates the schema
2. **Call `run_migrations_if_needed()`** at the end of initialization
3. **Done!** Migrations will run automatically

## Example: Adding a New Database

Let's say you want to add a new `analytics.db` database:

### Step 1: Create Schema File

Create `fastapi_app/lib/analytics_schema.py`:

```python
"""
Analytics database schema.
"""

import sqlite3
from pathlib import Path

CREATE_EVENTS_TABLE = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    data TEXT
)
"""

def initialize_analytics_db(conn: sqlite3.Connection, logger=None, db_path=None) -> None:
    """
    Initialize analytics database schema.

    Creates tables and runs any pending migrations.

    Args:
        conn: SQLite database connection
        logger: Optional logger instance
        db_path: Optional path to database file (needed for migrations)
    """
    try:
        cursor = conn.cursor()

        if logger:
            logger.info("Creating analytics tables...")

        # Create tables
        cursor.execute(CREATE_EVENTS_TABLE)

        conn.commit()

        if logger:
            logger.info("Analytics database schema initialized")

        # Run migrations if db_path provided
        if db_path:
            from pathlib import Path
            from .migration_runner import run_migrations_if_needed
            from .migrations.versions import ANALYTICS_MIGRATIONS  # Create a new list for this database

            run_migrations_if_needed(
                db_path=Path(db_path),
                migrations=ANALYTICS_MIGRATIONS,
                logger=logger
            )

    except sqlite3.Error as e:
        if logger:
            logger.error(f"Failed to initialize analytics database: {e}")
        raise
```

### Step 2: Create Database Manager (Optional)

If you want a database manager class (recommended for complex databases):

```python
"""
Analytics database manager.
"""

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Generator
from .analytics_schema import initialize_analytics_db


class AnalyticsDB:
    """Manages analytics database connections."""

    def __init__(self, db_path: Path, logger=None):
        self.db_path = db_path
        self.logger = logger
        self._ensure_db_exists()

    def _ensure_db_exists(self) -> None:
        """Ensure database and schema exist with migrations."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        with self.get_connection() as conn:
            initialize_analytics_db(conn, self.logger, db_path=self.db_path)

    @contextmanager
    def get_connection(self) -> Generator[sqlite3.Connection, None, None]:
        """Context manager for database connections."""
        conn = None
        try:
            conn = sqlite3.connect(str(self.db_path))
            conn.row_factory = sqlite3.Row
            yield conn
        except sqlite3.Error as e:
            if self.logger:
                self.logger.error(f"Database connection error: {e}")
            raise
        finally:
            if conn:
                conn.close()
```

### Step 3: Initialize in Application Startup

In `fastapi_app/main.py`, add initialization in the `lifespan` function:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown lifecycle"""
    # ... existing initialization code ...

    # Initialize analytics database
    from .lib.analytics_db import AnalyticsDB
    analytics_db_path = settings.db_dir / "analytics.db"
    try:
        analytics_db = AnalyticsDB(analytics_db_path, logger)
        logger.info(f"Analytics database initialized: {analytics_db_path}")
    except Exception as e:
        logger.error(f"Error initializing analytics database: {e}")
        raise

    yield
```

That's it! Migrations will now run automatically for your new database on application startup.

## How It Works

The `run_migrations_if_needed()` function:

1. **Checks if migrations are needed** by examining the `migration_history` table
2. **Compares registered migrations** against what's been applied
3. **Runs pending migrations** if any are found
4. **Caches the result** per-process to avoid re-checking on subsequent calls
5. **Returns the number** of migrations applied (0 if none needed)

## Migration System Integration

Migrations are organized by target database in `fastapi_app/lib/migrations/versions/__init__.py`:

- **Database-specific lists**: `LOCKS_MIGRATIONS`, `METADATA_MIGRATIONS`, etc.
- **Global list**: `ALL_MIGRATIONS` (for tools that need the complete list)
- Each database uses its specific migration list to avoid unnecessary checks

When adding a new database, create a new migration list for it in `fastapi_app/lib/migrations/versions/__init__.py`:

```python
ANALYTICS_MIGRATIONS = [
    Migration003AnalyticsIndexes,
    Migration005AnalyticsCleanup,
]
```

### Example Migration That Targets Specific Database

```python
class Migration003AnalyticsIndexes(Migration):
    """Add indexes to analytics database."""

    @property
    def version(self) -> int:
        return 3

    @property
    def description(self) -> str:
        return "Add indexes to analytics.events table"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        """Only apply if events table exists."""
        cursor = conn.execute("""
            SELECT name FROM sqlite_master
            WHERE type='table' AND name='events'
        """)
        if not cursor.fetchone():
            self.logger.info("Events table does not exist, skipping migration")
            return False
        return True

    def upgrade(self, conn: sqlite3.Connection) -> None:
        """Add indexes to events table."""
        conn.execute("CREATE INDEX IF NOT EXISTS idx_event_type ON events(event_type)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_timestamp ON events(timestamp)")
```

## Testing Your Database

Always test your database initialization:

```python
def test_analytics_db_initialization():
    import tempfile
    import shutil
    from pathlib import Path
    from fastapi_app.lib.analytics_db import AnalyticsDB
    from fastapi_app.lib.migration_runner import reset_migration_cache
    import logging

    logger = logging.getLogger('test')
    temp_dir = Path(tempfile.mkdtemp())

    try:
        # Test initialization
        db_path = temp_dir / 'test_analytics.db'
        db = AnalyticsDB(db_path, logger)

        # Verify schema
        import sqlite3
        with sqlite3.connect(str(db_path)) as conn:
            cursor = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
            tables = [row[0] for row in cursor.fetchall()]
            assert 'events' in tables
            assert 'migration_history' in tables

        print("✓ Database initialized correctly")
    finally:
        shutil.rmtree(temp_dir)
```

## Best Practices

1. **Always pass `db_path` to your initialization function** - This enables migrations
2. **Call `run_migrations_if_needed()` at the end** of schema initialization - This ensures tables exist before migrations run
3. **Use `check_can_apply()`** in migrations to target specific databases
4. **Test with a fresh database** to ensure initialization works correctly
5. **Document your schema** in the schema file

## Reference

- Migration system: [docs/development/migrations.md](migrations.md)
- Migration runner: `fastapi_app/lib/migration_runner.py`
- Example database: `fastapi_app/lib/database.py` (metadata.db)
- Example initialization: `fastapi_app/lib/locking.py` (locks.db)
