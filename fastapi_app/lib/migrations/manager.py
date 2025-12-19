"""
Migration manager for SQLite databases.

Handles migration execution, version tracking, and backups.
"""

import sqlite3
import shutil
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Type
import logging

from .base import Migration


class MigrationManager:
    """
    Manages database migrations with versioning and backups.

    Features:
    - Automatic database backups before migrations
    - Version tracking in migration_history table
    - Transactional migrations with automatic rollback
    - Idempotent operations
    """

    def __init__(self, db_path: Path, logger: Optional[logging.Logger] = None):
        """
        Initialize migration manager.

        Args:
            db_path: Path to SQLite database file
            logger: Optional logger instance
        """
        self.db_path = Path(db_path)
        self.logger = logger or logging.getLogger(__name__)
        self._migrations: List[Migration] = []

    def register_migration(self, migration: Migration) -> None:
        """
        Register a migration.

        Args:
            migration: Migration instance to register
        """
        self._migrations.append(migration)
        # Sort by version to ensure correct order
        self._migrations.sort(key=lambda m: m.version)

    def register_migrations(self, migrations: List[Migration]) -> None:
        """
        Register multiple migrations.

        Args:
            migrations: List of migration instances
        """
        for migration in migrations:
            self.register_migration(migration)

    def _ensure_migration_table(self, conn: sqlite3.Connection) -> None:
        """
        Ensure migration_history table exists.

        Args:
            conn: SQLite connection
        """
        conn.execute("""
            CREATE TABLE IF NOT EXISTS migration_history (
                version INTEGER PRIMARY KEY,
                description TEXT NOT NULL,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                success BOOLEAN DEFAULT 1
            )
        """)
        conn.commit()

    def _get_current_version(self, conn: sqlite3.Connection) -> int:
        """
        Get current database version.

        Args:
            conn: SQLite connection

        Returns:
            Current version number (0 if no migrations applied)
        """
        self._ensure_migration_table(conn)

        cursor = conn.execute("""
            SELECT MAX(version) as max_version
            FROM migration_history
            WHERE success = 1
        """)
        row = cursor.fetchone()
        return row[0] if row[0] is not None else 0

    def _record_migration(
        self,
        conn: sqlite3.Connection,
        migration: Migration,
        success: bool = True
    ) -> None:
        """
        Record migration in history.

        Args:
            conn: SQLite connection
            migration: Migration that was applied
            success: Whether migration succeeded
        """
        conn.execute("""
            INSERT OR REPLACE INTO migration_history (version, description, applied_at, success)
            VALUES (?, ?, CURRENT_TIMESTAMP, ?)
        """, (migration.version, migration.description, success))

    def _backup_database(self) -> Path:
        """
        Create a backup of the database.

        Returns:
            Path to backup file

        Raises:
            IOError: If backup fails
        """
        if not self.db_path.exists():
            raise IOError(f"Database file does not exist: {self.db_path}")

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = self.db_path.parent / f"{self.db_path.stem}_backup_{timestamp}{self.db_path.suffix}"

        self.logger.info(f"Creating database backup: {backup_path}")
        shutil.copy2(self.db_path, backup_path)

        return backup_path

    def _get_pending_migrations(self, current_version: int) -> List[Migration]:
        """
        Get migrations that need to be applied.

        Args:
            current_version: Current database version

        Returns:
            List of pending migrations in order
        """
        return [m for m in self._migrations if m.version > current_version]

    def run_migrations(self, target_version: Optional[int] = None, skip_backup: bool = False) -> int:
        """
        Run all pending migrations.

        Args:
            target_version: Target version to migrate to (None = latest)
            skip_backup: Skip database backup (not recommended for production)

        Returns:
            Number of migrations applied

        Raises:
            Exception: If any migration fails
        """
        # Ensure database file exists
        if not self.db_path.exists():
            self.logger.info(f"Database does not exist yet: {self.db_path}")
            return 0

        # Get current version
        with sqlite3.connect(str(self.db_path)) as conn:
            current_version = self._get_current_version(conn)

        self.logger.info(f"Current database version: {current_version}")

        # Get pending migrations
        pending = self._get_pending_migrations(current_version)
        if target_version is not None:
            pending = [m for m in pending if m.version <= target_version]

        if not pending:
            self.logger.info("No pending migrations")
            return 0

        self.logger.info(f"Found {len(pending)} pending migrations")

        # Backup database before migrations
        backup_path = None
        if not skip_backup:
            try:
                backup_path = self._backup_database()
            except Exception as e:
                self.logger.error(f"Failed to create backup: {e}")
                raise

        # Apply migrations
        applied_count = 0
        for migration in pending:
            self.logger.info(f"Applying migration {migration.version}: {migration.description}")

            try:
                with sqlite3.connect(str(self.db_path)) as conn:
                    # Ensure migration can be applied
                    if not migration.check_can_apply(conn):
                        self.logger.warning(
                            f"Migration {migration.version} cannot be applied (check_can_apply returned False)"
                        )
                        continue

                    # Begin transaction
                    conn.execute("BEGIN")

                    try:
                        # Apply migration
                        migration.upgrade(conn)

                        # Record success
                        self._record_migration(conn, migration, success=True)

                        # Commit
                        conn.commit()

                        applied_count += 1
                        self.logger.info(f"Successfully applied migration {migration.version}")

                    except Exception as e:
                        # Rollback on error
                        conn.rollback()
                        self.logger.error(f"Migration {migration.version} failed: {e}")

                        # Record failure
                        with sqlite3.connect(str(self.db_path)) as error_conn:
                            self._record_migration(error_conn, migration, success=False)
                            error_conn.commit()

                        raise

            except Exception as e:
                self.logger.error(f"Failed to apply migration {migration.version}: {e}")
                if backup_path:
                    self.logger.info(f"Database backup available at: {backup_path}")
                raise

        self.logger.info(f"Successfully applied {applied_count} migrations")
        if backup_path:
            self.logger.info(f"Backup saved at: {backup_path}")

        return applied_count

    def get_migration_history(self) -> List[dict]:
        """
        Get migration history.

        Returns:
            List of migration records with version, description, applied_at, success
        """
        if not self.db_path.exists():
            return []

        with sqlite3.connect(str(self.db_path)) as conn:
            conn.row_factory = sqlite3.Row
            self._ensure_migration_table(conn)

            cursor = conn.execute("""
                SELECT version, description, applied_at, success
                FROM migration_history
                ORDER BY version
            """)

            return [dict(row) for row in cursor.fetchall()]

    def rollback_migration(self, target_version: int) -> int:
        """
        Rollback migrations to a specific version.

        Args:
            target_version: Target version to rollback to

        Returns:
            Number of migrations rolled back

        Raises:
            Exception: If rollback fails
        """
        if not self.db_path.exists():
            self.logger.warning("Database does not exist, nothing to rollback")
            return 0

        # Get current version
        with sqlite3.connect(str(self.db_path)) as conn:
            current_version = self._get_current_version(conn)

        if target_version >= current_version:
            self.logger.info("Target version is current or higher, nothing to rollback")
            return 0

        # Get migrations to rollback (in reverse order)
        to_rollback = [m for m in self._migrations if target_version < m.version <= current_version]
        to_rollback.sort(key=lambda m: m.version, reverse=True)

        if not to_rollback:
            self.logger.warning("No migrations to rollback")
            return 0

        # Backup before rollback
        backup_path = self._backup_database()

        # Rollback migrations
        rolled_back = 0
        for migration in to_rollback:
            self.logger.info(f"Rolling back migration {migration.version}: {migration.description}")

            try:
                with sqlite3.connect(str(self.db_path)) as conn:
                    conn.execute("BEGIN")

                    try:
                        # Rollback migration
                        migration.downgrade(conn)

                        # Remove from history
                        conn.execute("DELETE FROM migration_history WHERE version = ?", (migration.version,))

                        # Commit
                        conn.commit()

                        rolled_back += 1
                        self.logger.info(f"Successfully rolled back migration {migration.version}")

                    except Exception as e:
                        conn.rollback()
                        self.logger.error(f"Rollback of migration {migration.version} failed: {e}")
                        raise

            except Exception as e:
                self.logger.error(f"Failed to rollback migration {migration.version}: {e}")
                self.logger.info(f"Database backup available at: {backup_path}")
                raise

        self.logger.info(f"Successfully rolled back {rolled_back} migrations")
        return rolled_back
