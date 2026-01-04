"""
Centralized migration runner for all databases.

Provides a simple, reusable function to run migrations on any database.
This eliminates the need to duplicate migration runner logic across different
database initialization code.

Usage:
    from fastapi_app.lib.migration_runner import run_migrations_if_needed
    from fastapi_app.lib.migrations.versions import ALL_MIGRATIONS

    # In your database initialization code:
    run_migrations_if_needed(
        db_path=Path("data/db/metadata.db"),
        migrations=ALL_MIGRATIONS,
        logger=logger
    )
"""

import sqlite3
from pathlib import Path
from typing import Optional


# Track which databases have had migrations run (per-process cache)
_migrations_run_for: set[str] = set()


def run_migrations_if_needed(
    db_path: Path,
    migrations: list,
    logger=None,
    force: bool = False
) -> int:
    """
    Run migrations on a database if needed.

    This function is idempotent and can be called multiple times safely.
    It uses a per-process cache to avoid re-running migrations within
    the same process, and checks migration_history table to avoid
    re-running migrations across process restarts.

    Args:
        db_path: Path to SQLite database file
        migrations: List of migration classes to register
        logger: Optional logger instance
        force: If True, bypass per-process cache and always check for pending migrations

    Returns:
        Number of migrations applied (0 if none needed)

    Example:
        from fastapi_app.lib.migrations.versions import ALL_MIGRATIONS

        applied = run_migrations_if_needed(
            db_path=Path("data/db/metadata.db"),
            migrations=ALL_MIGRATIONS,
            logger=logger
        )
    """
    from fastapi_app.lib.migrations import MigrationManager

    # Convert path to string for cache key
    db_path_str = str(db_path.resolve())

    # Skip if already run in this process (unless forced)
    if not force and db_path_str in _migrations_run_for:
        return 0

    try:
        # Check if migrations are needed by looking for pending migrations
        needs_migration = False

        if db_path.exists():
            with sqlite3.connect(str(db_path)) as conn:
                # Check if migration_history table exists
                cursor = conn.execute("""
                    SELECT name FROM sqlite_master
                    WHERE type='table' AND name='migration_history'
                """)
                has_history = cursor.fetchone() is not None

                if not has_history:
                    # No migration history = migrations needed
                    needs_migration = True
                else:
                    # Check if there are any registered migrations not in history
                    cursor = conn.execute("SELECT MAX(version) FROM migration_history WHERE success = 1")
                    row = cursor.fetchone()
                    current_version = row[0] if row and row[0] is not None else 0

                    # Check if any migration version is higher than current
                    for migration_class in migrations:
                        # Instantiate to get version (migrations need logger)
                        temp_migration = migration_class(logger)
                        if temp_migration.version > current_version:
                            needs_migration = True
                            break
        else:
            # Database doesn't exist yet, will be created by schema init
            # Run migrations after first initialization
            needs_migration = True

        # Run migrations if needed
        if needs_migration:
            if logger:
                logger.info(f"Running migrations for {db_path.name}...")

            manager = MigrationManager(db_path, logger)

            # Register all migrations
            for migration_class in migrations:
                manager.register_migration(migration_class(logger))

            # Run pending migrations
            applied = manager.run_migrations()

            if applied > 0 and logger:
                logger.info(f"Applied {applied} migration(s) to {db_path.name}")

            # Mark as completed for this process
            _migrations_run_for.add(db_path_str)

            return applied
        else:
            # No migrations needed, but mark as checked
            _migrations_run_for.add(db_path_str)
            return 0

    except Exception as e:
        if logger:
            logger.error(f"Failed to run migrations for {db_path.name}: {e}")
        raise


def reset_migration_cache() -> None:
    """
    Reset the per-process migration cache.

    This is primarily useful for testing when you want to force
    migrations to be re-checked within the same process.
    """
    global _migrations_run_for
    _migrations_run_for.clear()
