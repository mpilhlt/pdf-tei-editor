"""
Unit tests for Backup & Restore plugin.

@testCovers fastapi_app/plugins/backup_restore/plugin.py
@testCovers fastapi_app/plugins/backup_restore/routes.py
@testCovers fastapi_app/plugins/backup_restore/archive.py
@testCovers fastapi_app/lib/data_restore.py
"""

import hashlib
import io
import json
import shutil
import sqlite3
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
        self.assertEqual(meta["required_roles"], ["admin", "backup", "restore"])

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


class TestEnsureRoles(unittest.TestCase):
    """Test that the plugin adds its roles to roles.json idempotently."""

    def setUp(self):
        self.db_dir = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.db_dir)

    def test_adds_missing_roles_once_and_keeps_custom_roles(self):
        from fastapi_app.plugins.backup_restore.plugin import ensure_roles

        roles_file = self.db_dir / "roles.json"
        roles_file.write_text(json.dumps([{"id": "admin", "roleName": "Admin"}, {"id": "custom"}]))

        self.assertEqual(ensure_roles(self.db_dir), ["backup", "restore"])
        self.assertEqual(ensure_roles(self.db_dir), [])

        ids = [r["id"] for r in json.loads(roles_file.read_text())]
        self.assertEqual(ids, ["admin", "custom", "backup", "restore"])

    def test_missing_roles_file_is_ignored(self):
        from fastapi_app.plugins.backup_restore.plugin import ensure_roles

        self.assertEqual(ensure_roles(self.db_dir), [])

    def test_default_roles_file_contains_plugin_roles(self):
        from fastapi_app.plugins.backup_restore.plugin import PLUGIN_ROLES

        config = json.loads((Path(__file__).resolve().parents[4] / "config" / "roles.json").read_text())
        ids = {r["id"] for r in config}
        self.assertTrue({r["id"] for r in PLUGIN_ROLES} <= ids)


class TestAuthorization(unittest.TestCase):
    """Test the role matrix of the plugin routes."""

    def _authenticate(self, operation, roles):
        from fastapi import HTTPException
        from fastapi_app.plugins.backup_restore.routes import _authenticate

        session_manager = MagicMock()
        session_manager.is_session_valid.return_value = True
        auth_manager = MagicMock()
        auth_manager.get_user_by_session_id.return_value = {"username": "u", "roles": roles}
        try:
            _authenticate(operation, "sid", None, session_manager, auth_manager)
            return True
        except HTTPException as e:
            self.assertEqual(e.status_code, 403)
            return False

    def test_matrix(self):
        expected = {
            # roles: (view, backup, restore)
            ("backup",): (True, True, False),
            ("restore",): (True, False, True),
            ("backup", "restore"): (True, True, True),
            ("admin",): (True, True, True),
            ("*",): (True, True, True),
            ("user", "reviewer"): (False, False, False),
            (): (False, False, False),
        }
        for roles, allowed in expected.items():
            got = tuple(self._authenticate(op, list(roles)) for op in ("view", "backup", "restore"))
            self.assertEqual(got, allowed, f"roles={roles}")

    def test_missing_session_is_401(self):
        from fastapi import HTTPException
        from fastapi_app.plugins.backup_restore.routes import _authenticate

        with self.assertRaises(HTTPException) as ctx:
            _authenticate("backup", None, None, MagicMock(), MagicMock())
        self.assertEqual(ctx.exception.status_code, 401)


class TestBackupArchive(unittest.TestCase):
    """Test backup ZIP creation."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.data = self.root / "data"
        (self.data / "db").mkdir(parents=True)
        (self.data / "files" / "ab").mkdir(parents=True)
        (self.data / "tmp").mkdir()
        (self.data / "db" / "users.json").write_text("[]")
        (self.data / "db" / "config.json").write_text("{}")
        (self.data / "files" / "ab" / "doc.xml").write_text("<TEI/>")
        (self.data / "tmp" / "ignored.txt").write_text("x")

        # SQLite in WAL mode with an uncheckpointed write, connection kept open
        self.conn = sqlite3.connect(self.data / "db" / "metadata.db")
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA wal_autocheckpoint=0")
        self.conn.execute("CREATE TABLE t (v TEXT)")
        self.conn.execute("INSERT INTO t VALUES ('in-wal')")
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        shutil.rmtree(self.root)

    def test_zip_content_checksum_and_consistent_database(self):
        from fastapi_app.plugins.backup_restore.archive import create_backup_zip

        zip_path, sha = create_backup_zip(self.data, self.data / "tmp")
        self.assertEqual(sha, hashlib.sha256(zip_path.read_bytes()).hexdigest())

        with zipfile.ZipFile(zip_path) as zf:
            names = set(zf.namelist())
            self.assertEqual(
                names,
                {"db/users.json", "db/config.json", "db/metadata.db", "files/ab/doc.xml"},
            )
            out = self.root / "restored.db"
            out.write_bytes(zf.read("db/metadata.db"))

        restored = sqlite3.connect(out)
        try:
            self.assertEqual(restored.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(restored.execute("SELECT v FROM t").fetchone()[0], "in-wal")
        finally:
            restored.close()
        # no snapshot leftovers in the tmp dir besides the ZIP itself
        self.assertEqual([p.name for p in (self.data / "tmp").iterdir() if p.name != "ignored.txt"], [zip_path.name])


class TestDownloadRoute(unittest.TestCase):
    """Test the download endpoint end to end with dependency overrides."""

    def setUp(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from fastapi_app.lib.core.dependencies import get_auth_manager, get_session_manager
        from fastapi_app.plugins.backup_restore.routes import router

        self.root = Path(tempfile.mkdtemp())
        self.data = self.root / "data"
        (self.data / "db").mkdir(parents=True)
        (self.data / "db" / "users.json").write_text("[]")
        (self.data / "db" / "config.json").write_text("{}")

        self.roles = ["backup"]
        session_manager = MagicMock()
        session_manager.is_session_valid.return_value = True
        auth_manager = MagicMock()
        auth_manager.get_user_by_session_id.side_effect = lambda *a: {"username": "u", "roles": self.roles}

        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[get_session_manager] = lambda: session_manager
        app.dependency_overrides[get_auth_manager] = lambda: auth_manager
        self.client = TestClient(app)

        settings = MagicMock(
            data_root=self.data, tmp_dir=self.data / "tmp", session_timeout=3600,
            project_root_dir=Path(__file__).resolve().parents[4],
        )
        patcher = patch("fastapi_app.config.get_settings", return_value=settings)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_download_with_backup_role(self):
        r = self.client.get("/api/plugins/backup-restore/download", headers={"X-Session-ID": "s"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["x-content-sha256"], hashlib.sha256(r.content).hexdigest())
        self.assertEqual(int(r.headers["content-length"]), len(r.content))
        self.assertEqual(list((self.data / "tmp").glob("backup_*")), [])

    def test_download_denied_for_restore_only(self):
        self.roles = ["restore"]
        r = self.client.get("/api/plugins/backup-restore/download", headers={"X-Session-ID": "s"})
        self.assertEqual(r.status_code, 403)

    def test_restore_denied_for_backup_only(self):
        r = self.client.post(
            "/api/plugins/backup-restore/restore",
            headers={"X-Session-ID": "s"},
            files={"file": ("b.zip", b"x")},
        )
        self.assertEqual(r.status_code, 403)

    def test_concurrent_download_returns_409(self):
        import asyncio
        from fastapi_app.plugins.backup_restore import routes

        async def hold():
            await routes._backup_lock.acquire()

        loop = asyncio.new_event_loop()
        loop.run_until_complete(hold())
        try:
            r = self.client.get("/api/plugins/backup-restore/download", headers={"X-Session-ID": "s"})
            self.assertEqual(r.status_code, 409)
        finally:
            routes._backup_lock.release()
            loop.close()

    def test_view_shows_sections_by_role(self):
        self.roles = ["restore"]
        r = self.client.get("/api/plugins/backup-restore/view", headers={"X-Session-ID": "s"})
        self.assertEqual(r.status_code, 200)
        self.assertIn("const canBackup = false;", r.text)
        self.assertIn("const canRestore = true;", r.text)


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
