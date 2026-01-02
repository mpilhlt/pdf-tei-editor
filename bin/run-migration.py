#!/usr/bin/env python3
"""
Run database migrations manually.

Usage:
    python bin/run-migration.py [--db-path PATH] [--dry-run]
"""

import argparse
import logging
import sys
from pathlib import Path

# Add parent directory to path to import fastapi_app
sys.path.insert(0, str(Path(__file__).parent.parent))

from fastapi_app.lib.migrations import MigrationManager
from fastapi_app.lib.migrations.versions import ALL_MIGRATIONS

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def main():
    """Run database migrations."""
    parser = argparse.ArgumentParser(description='Run database migrations')
    parser.add_argument(
        '--db-path',
        type=Path,
        default=Path('data/db/metadata.db'),
        help='Path to database file (default: data/db/metadata.db)'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Check which migrations would run without applying them'
    )
    parser.add_argument(
        '--skip-backup',
        action='store_true',
        help='Skip database backup before migration (not recommended)'
    )

    args = parser.parse_args()

    if not args.db_path.exists():
        logger.error(f"Database not found: {args.db_path}")
        sys.exit(1)

    logger.info(f"Database: {args.db_path}")

    # Initialize migration manager
    manager = MigrationManager(args.db_path, logger)

    # Register all migrations
    for migration_class in ALL_MIGRATIONS:
        manager.register_migration(migration_class(logger))

    if args.dry_run:
        # Show migration history and registered migrations
        logger.info("DRY RUN - checking migration status")
        history = manager.get_migration_history()
        applied_versions = {record['version'] for record in history if record['success']}

        logger.info("Registered migrations:")
        for migration_class in ALL_MIGRATIONS:
            migration = migration_class(logger)
            version = migration.version
            status = "✓ Applied" if version in applied_versions else "⧗ Pending"
            logger.info(f"  {status} - Version {version}: {migration.description}")
    else:
        # Run migrations
        logger.info("Running migrations...")
        applied = manager.run_migrations(skip_backup=args.skip_backup)

        if applied > 0:
            logger.info(f"Successfully applied {applied} migration(s)")

            # Show migration history
            history = manager.get_migration_history()
            logger.info("Migration history:")
            for record in history:
                status = "✓" if record['success'] else "✗"
                logger.info(
                    f"  {status} Version {record['version']}: {record['description']}"
                    f" (applied: {record['applied_at']})"
                )
        else:
            logger.info("No migrations applied - database is up to date")


if __name__ == '__main__':
    main()
