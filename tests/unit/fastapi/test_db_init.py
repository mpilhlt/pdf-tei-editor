"""
Unit tests for database initialization module.

Tests the config/ → db/ initialization pattern.

@testCovers fastapi_app/lib/core/db_init.py
"""

import json
import tempfile
import shutil
from pathlib import Path
import pytest

from fastapi_app.lib.core.db_init import (
    initialize_db_from_config,
    clean_db_directory,
    ensure_db_initialized,
    _merge_config_defaults
)


class TestDbInit:
    """Test database initialization from config defaults."""

    @pytest.fixture
    def temp_dirs(self):
        """Create temporary config and db directories for testing."""
        temp_root = Path(tempfile.mkdtemp())
        config_dir = temp_root / "config"
        db_dir = temp_root / "db"

        config_dir.mkdir()
        db_dir.mkdir()

        # Create sample config files
        (config_dir / "config.json").write_text(json.dumps({
            "key1": "value1",
            "key2": "value2",
            "server": {"port": 8000}
        }, indent=2))

        (config_dir / "users.json").write_text(json.dumps([
            {"username": "admin", "role": "admin"}
        ], indent=2))

        yield config_dir, db_dir

        # Cleanup
        shutil.rmtree(temp_root)

    def test_initialize_db_from_config_copies_files(self, temp_dirs):
        """Test that JSON files are copied from config to db."""
        config_dir, db_dir = temp_dirs

        initialize_db_from_config(config_dir, db_dir)

        # Verify files were copied
        assert (db_dir / "config.json").exists()
        assert (db_dir / "users.json").exists()

        # Verify content is correct
        with open(db_dir / "config.json") as f:
            config = json.load(f)
            assert config["key1"] == "value1"

    def test_initialize_does_not_overwrite_existing(self, temp_dirs):
        """Test that existing files are not overwritten."""
        config_dir, db_dir = temp_dirs

        # Create existing file with different content
        (db_dir / "config.json").write_text(json.dumps({
            "key1": "modified",
            "custom_key": "custom_value"
        }, indent=2))

        initialize_db_from_config(config_dir, db_dir)

        # Verify original content preserved
        with open(db_dir / "config.json") as f:
            config = json.load(f)
            assert config["key1"] == "modified"
            assert "custom_key" in config

    def test_merge_config_defaults_adds_missing_keys(self, temp_dirs):
        """Test that missing config keys are added from template."""
        config_dir, db_dir = temp_dirs

        # Create db config with missing key
        db_config_path = db_dir / "config.json"
        db_config_path.write_text(json.dumps({
            "key1": "modified"
            # key2 is missing
        }, indent=2))

        template_path = config_dir / "config.json"

        _merge_config_defaults(template_path, db_config_path)

        # Verify missing key was added
        with open(db_config_path) as f:
            config = json.load(f)
            assert config["key1"] == "modified"  # Original preserved
            assert config["key2"] == "value2"     # Missing added
            assert config["server"]["port"] == 8000  # Nested added

    def test_clean_db_directory_removes_files(self, temp_dirs):
        """Test that clean removes JSON and SQLite files."""
        config_dir, db_dir = temp_dirs

        # Create various file types
        (db_dir / "config.json").write_text("{}")
        (db_dir / "test.db").write_text("")
        (db_dir / "test.db-shm").write_text("")
        (db_dir / "test.db-wal").write_text("")
        (db_dir / "keep.txt").write_text("")  # Should not be removed

        clean_db_directory(db_dir, keep_sqlite=False)

        # Verify files removed
        assert not (db_dir / "config.json").exists()
        assert not (db_dir / "test.db").exists()
        assert not (db_dir / "test.db-shm").exists()
        assert not (db_dir / "test.db-wal").exists()

        # Verify other files kept
        assert (db_dir / "keep.txt").exists()

    def test_clean_db_directory_keep_sqlite(self, temp_dirs):
        """Test that clean can preserve SQLite files."""
        config_dir, db_dir = temp_dirs

        (db_dir / "config.json").write_text("{}")
        (db_dir / "test.db").write_text("")

        clean_db_directory(db_dir, keep_sqlite=True)

        # JSON removed, SQLite kept
        assert not (db_dir / "config.json").exists()
        assert (db_dir / "test.db").exists()

    def test_force_overwrite(self, temp_dirs):
        """Test that force=True overwrites existing files."""
        config_dir, db_dir = temp_dirs

        # Create existing file
        (db_dir / "config.json").write_text(json.dumps({
            "key1": "modified"
        }, indent=2))

        initialize_db_from_config(config_dir, db_dir, force=True)

        # Verify file was overwritten
        with open(db_dir / "config.json") as f:
            config = json.load(f)
            assert config["key1"] == "value1"  # Reset to default

    def test_creates_db_directory_if_missing(self, temp_dirs):
        """Test that db directory is created if it doesn't exist."""
        config_dir, _ = temp_dirs
        new_db_dir = config_dir.parent / "new_db"

        assert not new_db_dir.exists()

        initialize_db_from_config(config_dir, new_db_dir)

        assert new_db_dir.exists()
        assert (new_db_dir / "config.json").exists()


@pytest.mark.integration
class TestProjectStructure:
    """Integration tests that verify the actual project structure.

    These tests check that required config files exist in the project.
    They are marked with @pytest.mark.integration so they can be skipped
    in pure unit test runs.
    """

    def test_config_directory_exists(self):
        """Verify config directory exists with required files."""
        # Go up from tests/unit/fastapi/ to project root
        project_root = Path(__file__).parent.parent.parent.parent
        config_dir = project_root / "config"

        assert config_dir.exists(), "config/ directory should exist"
        assert (config_dir / "config.json").exists(), "config.json should exist"
        assert (config_dir / "users.json").exists(), "users.json should exist"
        assert (config_dir / "prompt.json").exists(), "prompt.json should exist"

    def test_default_users_file_structure(self):
        """Verify default user configuration has proper structure."""
        # Go up from tests/unit/fastapi/ to project root
        project_root = Path(__file__).parent.parent.parent.parent
        config_dir = project_root / "config"
        users_path = config_dir / "users.json"

        with open(users_path) as f:
            users = json.load(f)

        # Check admin exists with expected fields
        admin = next((u for u in users if u["username"] == "admin"), None)
        assert admin is not None, "Admin user should exist in defaults"
        assert "roles" in admin, "Admin user should have roles field"
        assert isinstance(admin["roles"], list), "Roles should be a list"
        assert len(admin["roles"]) > 0, "Admin user should have at least one role"

    def test_data_directory_structure(self):
        """Verify the data directory structure exists."""
        # Go up from tests/unit/fastapi/ to project root
        project_root = Path(__file__).parent.parent.parent.parent
        config_dir = project_root / "config"
        data_dir = project_root / "data"

        assert config_dir.exists(), "config/ directory should exist"
        assert data_dir.exists(), "data/ directory should exist"
        # db directory is created on demand, so we don't assert it exists
