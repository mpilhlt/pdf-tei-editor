"""
Unit tests for database migration infrastructure.

Tests the MigrationManager and Migration base class.

@testCovers fastapi_app/lib/migrations/manager.py
@testCovers fastapi_app/lib/migrations/base.py
"""

import unittest
import sqlite3
import tempfile
import logging
from pathlib import Path

from fastapi_app.lib.migrations import MigrationManager, Migration


# Test migrations
class TestMigration001(Migration):
    """First test migration - add users table."""

    @property
    def version(self) -> int:
        return 1

    @property
    def description(self) -> str:
        return "Create users table"

    def upgrade(self, conn: sqlite3.Connection) -> None:
        conn.execute("""
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE
            )
        """)

    def downgrade(self, conn: sqlite3.Connection) -> None:
        conn.execute("DROP TABLE IF EXISTS users")


class TestMigration002(Migration):
    """Second test migration - add posts table."""

    @property
    def version(self) -> int:
        return 2

    @property
    def description(self) -> str:
        return "Create posts table"

    def upgrade(self, conn: sqlite3.Connection) -> None:
        conn.execute("""
            CREATE TABLE posts (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                content TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """)

    def downgrade(self, conn: sqlite3.Connection) -> None:
        conn.execute("DROP TABLE IF EXISTS posts")


class TestMigration003Conditional(Migration):
    """Third test migration - conditional upgrade."""

    @property
    def version(self) -> int:
        return 3

    @property
    def description(self) -> str:
        return "Add comments table (conditional)"

    def check_can_apply(self, conn: sqlite3.Connection) -> bool:
        # Only apply if posts table exists
        cursor = conn.execute("""
            SELECT name FROM sqlite_master
            WHERE type='table' AND name='posts'
        """)
        return cursor.fetchone() is not None

    def upgrade(self, conn: sqlite3.Connection) -> None:
        conn.execute("""
            CREATE TABLE comments (
                id INTEGER PRIMARY KEY,
                post_id INTEGER NOT NULL,
                content TEXT NOT NULL,
                FOREIGN KEY (post_id) REFERENCES posts(id)
            )
        """)

    def downgrade(self, conn: sqlite3.Connection) -> None:
        conn.execute("DROP TABLE IF EXISTS comments")


class TestMigrations(unittest.TestCase):
    """Test migration infrastructure."""

    def setUp(self):
        """Create temporary database for each test."""
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = Path(self.temp_dir) / "test.db"
        self.logger = logging.getLogger("test_migrations")
        self.logger.setLevel(logging.DEBUG)

    def tearDown(self):
        """Clean up temporary database."""
        import shutil
        if Path(self.temp_dir).exists():
            shutil.rmtree(self.temp_dir)

    def test_migration_manager_initialization(self):
        """Test MigrationManager initializes correctly."""
        # Create empty database
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("SELECT 1")

        manager = MigrationManager(self.db_path, self.logger)
        self.assertEqual(manager.db_path, self.db_path)
        self.assertIsNotNone(manager.logger)

    def test_register_and_sort_migrations(self):
        """Test migrations are registered and sorted by version."""
        manager = MigrationManager(self.db_path, self.logger)

        # Register migrations out of order
        manager.register_migration(TestMigration002(self.logger))
        manager.register_migration(TestMigration001(self.logger))

        # Should be sorted by version
        self.assertEqual(len(manager._migrations), 2)
        self.assertEqual(manager._migrations[0].version, 1)
        self.assertEqual(manager._migrations[1].version, 2)

    def test_run_migrations_creates_history_table(self):
        """Test migration_history table is created."""
        # Create empty database
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("SELECT 1")

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(TestMigration001(self.logger))

        manager.run_migrations(skip_backup=True)

        # Check history table exists
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("""
                SELECT name FROM sqlite_master
                WHERE type='table' AND name='migration_history'
            """)
            self.assertIsNotNone(cursor.fetchone())

    def test_run_single_migration(self):
        """Test running a single migration."""
        # Create empty database
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("SELECT 1")

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(TestMigration001(self.logger))

        applied = manager.run_migrations(skip_backup=True)

        self.assertEqual(applied, 1)

        # Check table was created
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("""
                SELECT name FROM sqlite_master
                WHERE type='table' AND name='users'
            """)
            self.assertIsNotNone(cursor.fetchone())

    def test_run_multiple_migrations(self):
        """Test running multiple migrations in sequence."""
        # Create empty database
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("SELECT 1")

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migrations([
            TestMigration001(self.logger),
            TestMigration002(self.logger)
        ])

        applied = manager.run_migrations(skip_backup=True)

        self.assertEqual(applied, 2)

        # Check both tables were created
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("""
                SELECT name FROM sqlite_master
                WHERE type='table' AND name IN ('users', 'posts')
                ORDER BY name
            """)
            tables = [row[0] for row in cursor.fetchall()]
            self.assertEqual(tables, ['posts', 'users'])

    def test_idempotent_migrations(self):
        """Test migrations are not re-applied."""
        # Create empty database
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("SELECT 1")

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(TestMigration001(self.logger))

        # Run first time
        applied1 = manager.run_migrations(skip_backup=True)
        self.assertEqual(applied1, 1)

        # Run second time - should not re-apply
        applied2 = manager.run_migrations(skip_backup=True)
        self.assertEqual(applied2, 0)

    def test_migration_history_tracking(self):
        """Test migration history is recorded correctly."""
        # Create empty database
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("SELECT 1")

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migrations([
            TestMigration001(self.logger),
            TestMigration002(self.logger)
        ])

        manager.run_migrations(skip_backup=True)

        # Check history
        history = manager.get_migration_history()
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0]['version'], 1)
        self.assertEqual(history[0]['description'], "Create users table")
        self.assertEqual(history[0]['success'], 1)
        self.assertEqual(history[1]['version'], 2)
        self.assertEqual(history[1]['description'], "Create posts table")

    def test_target_version(self):
        """Test migrating to a specific target version."""
        # Create empty database
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("SELECT 1")

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migrations([
            TestMigration001(self.logger),
            TestMigration002(self.logger),
            TestMigration003Conditional(self.logger)
        ])

        # Migrate only to version 1
        applied = manager.run_migrations(target_version=1, skip_backup=True)
        self.assertEqual(applied, 1)

        # Check only first table exists
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("""
                SELECT name FROM sqlite_master
                WHERE type='table' AND name='users'
            """)
            self.assertIsNotNone(cursor.fetchone())

            cursor = conn.execute("""
                SELECT name FROM sqlite_master
                WHERE type='table' AND name='posts'
            """)
            self.assertIsNone(cursor.fetchone())

    def test_conditional_migration(self):
        """Test conditional migration using check_can_apply."""
        # Create empty database
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("SELECT 1")

        manager = MigrationManager(self.db_path, self.logger)

        # Try to apply migration 3 without migration 2 (should skip)
        manager.register_migrations([
            TestMigration001(self.logger),
            TestMigration003Conditional(self.logger)
        ])

        applied = manager.run_migrations(skip_backup=True)
        # Should only apply migration 1
        self.assertEqual(applied, 1)

        # Now add migration 2 and 3
        manager2 = MigrationManager(self.db_path, self.logger)
        manager2.register_migrations([
            TestMigration001(self.logger),
            TestMigration002(self.logger),
            TestMigration003Conditional(self.logger)
        ])

        applied2 = manager2.run_migrations(skip_backup=True)
        # Should apply migrations 2 and 3
        self.assertEqual(applied2, 2)

    def test_rollback_migration(self):
        """Test rolling back migrations."""
        # Create empty database
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("SELECT 1")

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migrations([
            TestMigration001(self.logger),
            TestMigration002(self.logger)
        ])

        # Apply both migrations
        manager.run_migrations(skip_backup=True)

        # Rollback to version 1
        rolled_back = manager.rollback_migration(target_version=1)
        self.assertEqual(rolled_back, 1)

        # Check posts table is gone
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("""
                SELECT name FROM sqlite_master
                WHERE type='table' AND name='posts'
            """)
            self.assertIsNone(cursor.fetchone())

            # But users table still exists
            cursor = conn.execute("""
                SELECT name FROM sqlite_master
                WHERE type='table' AND name='users'
            """)
            self.assertIsNotNone(cursor.fetchone())

    def test_backup_creation(self):
        """Test database backup is created before migration."""
        # Create empty database
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("CREATE TABLE test (id INTEGER)")

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(TestMigration001(self.logger))

        # Run with backup (default)
        manager.run_migrations()

        # Check backup file exists
        backup_files = list(Path(self.temp_dir).glob("test_backup_*.db"))
        self.assertEqual(len(backup_files), 1)

    def test_transaction_rollback_on_error(self):
        """Test migration is rolled back on error."""

        class FailingMigration(Migration):
            @property
            def version(self) -> int:
                return 99

            @property
            def description(self) -> str:
                return "Failing migration"

            def upgrade(self, conn: sqlite3.Connection) -> None:
                conn.execute("CREATE TABLE test (id INTEGER)")
                raise RuntimeError("Intentional failure")

            def downgrade(self, conn: sqlite3.Connection) -> None:
                pass

        # Create empty database
        with sqlite3.connect(str(self.db_path)) as conn:
            conn.execute("SELECT 1")

        manager = MigrationManager(self.db_path, self.logger)
        manager.register_migration(FailingMigration(self.logger))

        # Should raise error
        with self.assertRaises(RuntimeError):
            manager.run_migrations(skip_backup=True)

        # Check table was NOT created (transaction rolled back)
        with sqlite3.connect(str(self.db_path)) as conn:
            cursor = conn.execute("""
                SELECT name FROM sqlite_master
                WHERE type='table' AND name='test'
            """)
            self.assertIsNone(cursor.fetchone())


if __name__ == '__main__':
    unittest.main()
