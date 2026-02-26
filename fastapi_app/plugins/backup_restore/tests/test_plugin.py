"""
Unit tests for Backup & Restore plugin.

@testCovers fastapi_app/plugins/backup_restore/plugin.py
@testCovers fastapi_app/plugins/backup_restore/routes.py
@testCovers fastapi_app/lib/data_restore.py
"""

import io
import json
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch


class TestBackupRestorePlugin(unittest.TestCase):
    """Test plugin metadata and endpoint."""

    def test_metadata(self):
        from fastapi_app.plugins.backup_restore.plugin import BackupRestorePlugin

        plugin = BackupRestorePlugin()
        meta = plugin.metadata
        self.assertEqual(meta["id"], "backup-restore")
        self.assertEqual(meta["category"], "admin")
        self.assertEqual(meta["required_roles"], ["admin"])

    def test_manage_endpoint_returns_output_url(self):
        from fastapi_app.plugins.backup_restore.plugin import BackupRestorePlugin

        plugin = BackupRestorePlugin()
        import asyncio

        result = asyncio.new_event_loop().run_until_complete(
            plugin.manage(None, {})
        )
        self.assertIn("outputUrl", result)
        self.assertEqual(result["outputUrl"], "/api/plugins/backup-restore/view")


class TestDataRestore(unittest.TestCase):
    """Test the data_restore utility module."""

    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.temp_dir)

    def test_apply_pending_restore_swaps_directories(self):
        """Verify data_restore/ is swapped into data/ and old data is preserved."""
        from fastapi_app.lib.core.data_restore import apply_pending_restore

        data_dir = self.temp_dir / "data"
        data_dir.mkdir()
        (data_dir / "db").mkdir()
        (data_dir / "db" / "config.json").write_text('{"old": true}')

        restore_dir = self.temp_dir / "data_restore"
        restore_dir.mkdir()
        (restore_dir / "db").mkdir()
        (restore_dir / "db" / "config.json").write_text('{"restored": true}')
        # Restore ZIP includes .gitignore
        (restore_dir / ".gitignore").write_text("*\n!.gitignore\n")

        logger = MagicMock()

        result = apply_pending_restore(self.temp_dir, data_dir, logger)

        self.assertTrue(result)
        # data/ should now contain the restored content
        config = json.loads((data_dir / "db" / "config.json").read_text())
        self.assertTrue(config.get("restored"))
        # Old data should be preserved in data_{timestamp}/
        backup_dirs = [d for d in self.temp_dir.iterdir() if d.name.startswith("data_2")]
        self.assertEqual(len(backup_dirs), 1)
        old_config = json.loads(
            (backup_dirs[0] / "db" / "config.json").read_text()
        )
        self.assertTrue(old_config.get("old"))
        # .gitignore should be copied to archived directory
        self.assertTrue((backup_dirs[0] / ".gitignore").exists())
        # data_restore/ should no longer exist
        self.assertFalse(restore_dir.exists())

    def test_apply_pending_restore_no_restore_dir(self):
        """Return False when no data_restore/ directory exists."""
        from fastapi_app.lib.core.data_restore import apply_pending_restore

        data_dir = self.temp_dir / "data"
        data_dir.mkdir()
        logger = MagicMock()

        result = apply_pending_restore(self.temp_dir, data_dir, logger)
        self.assertFalse(result)

    def test_apply_pending_restore_no_existing_data(self):
        """Handle case where data/ does not exist yet."""
        from fastapi_app.lib.core.data_restore import apply_pending_restore

        data_dir = self.temp_dir / "data"
        restore_dir = self.temp_dir / "data_restore"
        restore_dir.mkdir()
        (restore_dir / "db").mkdir()
        (restore_dir / "db" / "config.json").write_text("{}")

        logger = MagicMock()

        result = apply_pending_restore(self.temp_dir, data_dir, logger)
        self.assertTrue(result)
        self.assertTrue(data_dir.exists())
        self.assertFalse(restore_dir.exists())


class TestRestoreZipValidation(unittest.TestCase):
    """Test ZIP validation logic in the restore route."""

    def _create_zip(self, files: dict[str, str]) -> bytes:
        """Create a ZIP file in memory with the given files."""
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            for name, content in files.items():
                zf.writestr(name, content)
        return buf.getvalue()

    def test_required_files_constant(self):
        from fastapi_app.plugins.backup_restore.routes import REQUIRED_FILES

        self.assertIn("db/users.json", REQUIRED_FILES)
        self.assertIn("db/config.json", REQUIRED_FILES)

    def test_valid_zip_with_direct_structure(self):
        """A ZIP with db/users.json and db/config.json should be valid."""
        zip_bytes = self._create_zip({
            "db/users.json": "[]",
            "db/config.json": "{}",
            "db/metadata.db": "",
            "files/abc/tei/doc.xml": "<TEI/>",
        })
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
        names = set(zf.namelist())

        from fastapi_app.plugins.backup_restore.routes import REQUIRED_FILES

        missing = []
        for req in REQUIRED_FILES:
            if req not in names and f"data/{req}" not in names:
                missing.append(req)

        self.assertEqual(missing, [])

    def test_valid_zip_with_data_prefix(self):
        """A ZIP with data/db/users.json should also be accepted."""
        zip_bytes = self._create_zip({
            "data/db/users.json": "[]",
            "data/db/config.json": "{}",
        })
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
        names = set(zf.namelist())

        from fastapi_app.plugins.backup_restore.routes import REQUIRED_FILES

        missing = []
        for req in REQUIRED_FILES:
            if req not in names and f"data/{req}" not in names:
                missing.append(req)

        self.assertEqual(missing, [])

    def test_invalid_zip_missing_users(self):
        """A ZIP without users.json should fail validation."""
        zip_bytes = self._create_zip({
            "db/config.json": "{}",
        })
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
        names = set(zf.namelist())

        from fastapi_app.plugins.backup_restore.routes import REQUIRED_FILES

        missing = []
        for req in REQUIRED_FILES:
            if req not in names and f"data/{req}" not in names:
                missing.append(req)

        self.assertIn("db/users.json", missing)


class TestSupervisorDetection(unittest.TestCase):
    """Test the _is_supervised() heuristic."""

    @patch("fastapi_app.plugins.backup_restore.routes.Path")
    @patch("os.environ", {})
    @patch("os.getppid", return_value=12345)
    @patch("os.uname")
    def test_docker_detected(self, mock_uname, mock_ppid, MockPath):
        """Docker container is detected via /.dockerenv."""
        from fastapi_app.plugins.backup_restore.routes import _is_supervised

        def path_side_effect(p):
            mock = MagicMock()
            mock.exists.return_value = (p == "/.dockerenv")
            return mock

        MockPath.side_effect = path_side_effect
        mock_uname.return_value = MagicMock(sysname="Linux")

        self.assertTrue(_is_supervised())

    @patch("fastapi_app.plugins.backup_restore.routes.Path")
    @patch("os.environ", {"INVOCATION_ID": "abc123"})
    @patch("os.getppid", return_value=12345)
    @patch("os.uname")
    def test_systemd_detected(self, mock_uname, mock_ppid, MockPath):
        """systemd is detected via INVOCATION_ID env var."""
        from fastapi_app.plugins.backup_restore.routes import _is_supervised

        MockPath.return_value.exists.return_value = False
        mock_uname.return_value = MagicMock(sysname="Linux")

        self.assertTrue(_is_supervised())


if __name__ == "__main__":
    unittest.main()
