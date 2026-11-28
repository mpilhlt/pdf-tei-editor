"""
Unit tests for Backup & Restore plugin.

@testCovers fastapi_app/plugins/backup_restore/plugin.py
@testCovers fastapi_app/plugins/backup_restore/routes.py
@testCovers fastapi_app/plugins/backup_restore/archive.py
@testCovers fastapi_app/plugins/backup_restore/manifest.py
@testCovers fastapi_app/lib/core/data_restore.py
@testCovers fastapi_app/lib/core/worker_recycle.py
"""

import hashlib
import io
import json
import shutil
import sqlite3
import sys
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


def _zip(path: Path, files: dict[str, str]) -> Path:
    """Write a ZIP with the given members."""
    with zipfile.ZipFile(path, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return path


MANIFEST = json.dumps({"format": 1, "pte_version": "0.76.0"})


class TestBackupVersionCompatibility(unittest.TestCase):
    """Test the version rule of fastapi_app.plugins.backup_restore.manifest."""

    def test_compatibility_line(self):
        from fastapi_app.plugins.backup_restore.manifest import compatibility_line

        self.assertEqual(compatibility_line("0.76.3"), (0, 76))
        self.assertEqual(compatibility_line("0.77.0-devel.2"), (0, 77))
        self.assertEqual(compatibility_line("1.0.0"), (1,))
        self.assertEqual(compatibility_line("2.5.1"), (2,))

    def test_compatible_pairs(self):
        from fastapi_app.plugins.backup_restore.manifest import check_compatible

        for backup, current in [
            ("0.76.0", "0.76.0"),
            ("0.76.5", "0.76.0"),
            ("0.76.0", "0.76.9"),
            ("1.0.0", "1.9.3"),
            ("1.9.3", "1.0.0"),
            ("2.1.0-beta.1", "2.4.0"),
        ]:
            with self.subTest(backup=backup, current=current):
                check_compatible(backup, current)

    def test_incompatible_pairs(self):
        from fastapi_app.plugins.backup_restore.manifest import IncompatibleBackupError, check_compatible

        for backup, current in [
            ("0.75.4", "0.76.0"),
            ("0.77.0", "0.76.0"),
            ("0.99.0", "1.0.0"),
            ("1.4.0", "2.0.0"),
            ("2.0.0", "1.4.0"),
        ]:
            with self.subTest(backup=backup, current=current):
                with self.assertRaises(IncompatibleBackupError) as ctx:
                    check_compatible(backup, current)
                self.assertIn(backup, str(ctx.exception))
                self.assertIn(current, str(ctx.exception))

    def test_unversioned_or_invalid_backup_is_incompatible(self):
        from fastapi_app.plugins.backup_restore.manifest import IncompatibleBackupError, check_compatible

        for backup, current in [(None, "0.76.0"), ("garbage", "0.76.0"), ("0.76.0", None)]:
            with self.subTest(backup=backup, current=current):
                with self.assertRaises(IncompatibleBackupError):
                    check_compatible(backup, current)

    def test_read_backup_version(self):
        from fastapi_app.plugins.backup_restore.manifest import IncompatibleBackupError, read_backup_version

        def read(files: dict[str, str], prefix: str | None = None) -> str | None:
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as zf:
                for name, content in files.items():
                    zf.writestr(name, content)
            with zipfile.ZipFile(buf) as zf:
                return read_backup_version(zf, prefix)

        self.assertEqual(read({"backup-manifest.json": MANIFEST}), "0.76.0")
        self.assertEqual(read({"data/backup-manifest.json": MANIFEST}, "data"), "0.76.0")
        self.assertIsNone(read({"db/users.json": "[]"}))
        with self.assertRaises(IncompatibleBackupError):
            read({"backup-manifest.json": "not json"})
        with self.assertRaises(IncompatibleBackupError):
            read({"backup-manifest.json": '{"format": 1}'})


class TestDataRestore(unittest.TestCase):
    """Test staging and applying restores (fastapi_app.lib.core.data_restore)."""

    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp())
        self.data = self.temp_dir / "data"
        (self.data / "db").mkdir(parents=True)
        (self.data / "db" / "config.json").write_text('{"old": true}')
        (self.data / "files").mkdir()
        (self.data / "files" / "old.xml").write_text("<old/>")
        (self.data / "plugins" / "site").mkdir(parents=True)
        (self.data / "plugins" / "site" / "wheel.txt").write_text("code")
        (self.data / "plugins" / "work").mkdir()
        (self.data / ".gitignore").write_text("*\n")
        self.logger = MagicMock()

    def tearDown(self):
        shutil.rmtree(self.temp_dir)

    def _stage(self, files: dict[str, str], prefix: str | None = None) -> int:
        from fastapi_app.lib.core.data_restore import stage_restore

        return stage_restore(_zip(self.temp_dir / "b.zip", files), self.data, prefix)

    def _backup(self) -> dict[str, str]:
        return {"db/users.json": "[]", "db/config.json": '{"restored": true}', "files/new.xml": "<new/>"}

    def test_stage_then_apply_swaps_contents_and_keeps_old_data(self):
        from fastapi_app.lib.core.data_restore import PREVIOUS_DIR, apply_pending_restore, is_restore_pending

        self.assertEqual(self._stage(self._backup()), 3)
        self.assertTrue(is_restore_pending(self.data))
        self.assertTrue(json.loads((self.data / "db" / "config.json").read_text())["old"])

        self.assertTrue(apply_pending_restore(self.data, self.logger))

        self.assertTrue(json.loads((self.data / "db" / "config.json").read_text())["restored"])
        self.assertEqual(sorted(p.name for p in (self.data / "files").iterdir()), ["new.xml"])
        self.assertTrue((self.data / "plugins" / "site" / "wheel.txt").exists())
        self.assertFalse((self.data / "plugins" / "work").exists())
        self.assertTrue((self.data / ".gitignore").exists())
        self.assertFalse(is_restore_pending(self.data))
        archives = list((self.data / PREVIOUS_DIR).iterdir())
        self.assertEqual(len(archives), 1)
        self.assertEqual(sorted(p.name for p in archives[0].iterdir()), ["db", "files", "plugins"])
        self.assertTrue((archives[0] / "plugins" / "work").is_dir())
        self.assertTrue(json.loads((archives[0] / "db" / "config.json").read_text())["old"])
        self.assertFalse(apply_pending_restore(self.data, self.logger))

    def test_applied_restore_is_recorded(self):
        from fastapi_app.lib.core.data_restore import PREVIOUS_DIR, apply_pending_restore, read_applied_restore

        self.assertIsNone(read_applied_restore(self.data))
        self._stage(self._backup())
        apply_pending_restore(self.data, self.logger)
        applied = read_applied_restore(self.data)
        assert applied is not None
        self.assertEqual(applied["id"], next((self.data / PREVIOUS_DIR).iterdir()).name)
        # A second restore keeps the marker in place and replaces it
        self._stage(self._backup())
        with patch("fastapi_app.lib.core.data_restore.datetime") as clock:
            from datetime import datetime as real_datetime

            clock.now.return_value = real_datetime(2030, 1, 1)
            apply_pending_restore(self.data, self.logger, now=clock.now)
        self.assertEqual(read_applied_restore(self.data)["id"], "20300101_000000")

    def test_nothing_staged(self):
        from fastapi_app.lib.core.data_restore import apply_pending_restore

        self.assertFalse(apply_pending_restore(self.data, self.logger))
        self.assertTrue(json.loads((self.data / "db" / "config.json").read_text())["old"])

    def test_data_prefix_is_stripped(self):
        from fastapi_app.lib.core.data_restore import apply_pending_restore

        self._stage({"data/db/users.json": "[]", "data/db/config.json": "{}", "other/x": ""}, "data")
        apply_pending_restore(self.data, self.logger)
        self.assertTrue((self.data / "db" / "users.json").exists())
        self.assertFalse((self.data / "other").exists())

    def test_unsafe_paths_are_refused(self):
        from fastapi_app.lib.core.data_restore import STAGING_DIR, RestoreError

        for name in ("../evil", "db/../../evil", "/abs", "C:/evil", "db\\..\\evil"):
            with self.subTest(name=name), self.assertRaises(RestoreError):
                self._stage({"db/users.json": "[]", name: "x"})
            self.assertFalse((self.data / STAGING_DIR).exists())
        self.assertFalse((self.temp_dir / "evil").exists())

    def test_manifest_is_not_extracted(self):
        from fastapi_app.lib.core.data_restore import STAGING_DIR

        self.assertEqual(self._stage({"backup-manifest.json": MANIFEST, "db/config.json": "{}"}), 1)
        self.assertFalse((self.data / STAGING_DIR / "data" / "backup-manifest.json").exists())

    def test_reserved_names_are_not_extracted(self):
        from fastapi_app.lib.core.data_restore import PREVIOUS_DIR, apply_pending_restore

        self._stage({**self._backup(), f"{PREVIOUS_DIR}/x": "", ".restore.lock": ""})
        apply_pending_restore(self.data, self.logger)
        archive = next((self.data / PREVIOUS_DIR).iterdir())
        self.assertNotEqual(archive.name, "x")
        self.assertEqual(len(list((self.data / PREVIOUS_DIR).iterdir())), 1)

    def test_interrupted_swap_is_completed(self):
        from fastapi_app.lib.core.data_restore import PREVIOUS_DIR, STAGING_DIR, apply_pending_restore

        self._stage(self._backup())
        staging = self.data / STAGING_DIR
        # State after a crash between moving the old contents out and moving the new ones in
        archive = self.data / PREVIOUS_DIR / "20260101_000000"
        archive.mkdir(parents=True)
        (staging / "archive").write_text(archive.name)
        for name in ("db", "files", "plugins"):
            (self.data / name).rename(archive / name)
        (staging / "moved-out").touch()
        (staging / "data" / "db").rename(self.data / "db")

        self.assertTrue(apply_pending_restore(self.data, self.logger))
        self.assertTrue(json.loads((self.data / "db" / "config.json").read_text())["restored"])
        self.assertTrue((self.data / "files" / "new.xml").exists())
        self.assertEqual([p.name for p in (self.data / PREVIOUS_DIR).iterdir()], [archive.name])
        self.assertFalse(staging.exists())

    def test_entry_recreated_by_old_worker_is_archived(self):
        from fastapi_app.lib.core.data_restore import PREVIOUS_DIR, STAGING_DIR, apply_pending_restore

        self._stage(self._backup())
        staging = self.data / STAGING_DIR
        archive = self.data / PREVIOUS_DIR / "20260101_000000"
        archive.mkdir(parents=True)
        (staging / "archive").write_text(archive.name)
        for name in ("db", "files", "plugins"):
            (self.data / name).rename(archive / name)
        (staging / "moved-out").touch()
        (self.data / "db").mkdir()  # recreated by a worker of the previous generation

        self.assertTrue(apply_pending_restore(self.data, self.logger))
        self.assertTrue((self.data / "db" / "users.json").exists())
        self.assertTrue((archive / "db.1").is_dir())

    @unittest.skipIf(sys.platform == "win32", "flock")
    def test_concurrent_workers_apply_once(self):
        from concurrent.futures import ThreadPoolExecutor

        from fastapi_app.lib.core.data_restore import apply_pending_restore

        self._stage(self._backup())
        with ThreadPoolExecutor(4) as pool:
            results = list(pool.map(lambda _: apply_pending_restore(self.data, self.logger), range(4)))
        self.assertEqual(results.count(True), 1)
        self.assertTrue(json.loads((self.data / "db" / "config.json").read_text())["restored"])


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

    def _authorize(self, operation, roles):
        from fastapi import HTTPException
        from fastapi_app.plugins.backup_restore.routes import _authorize

        try:
            _authorize(operation, {"username": "u", "roles": roles})
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
            got = tuple(self._authorize(op, list(roles)) for op in ("view", "backup", "restore"))
            self.assertEqual(got, allowed, f"roles={roles}")



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

        zip_path, sha = create_backup_zip(self.data, self.data / "tmp", "0.76.0")
        self.assertEqual(sha, hashlib.sha256(zip_path.read_bytes()).hexdigest())

        with zipfile.ZipFile(zip_path) as zf:
            names = set(zf.namelist())
            self.assertEqual(
                names,
                {"backup-manifest.json", "db/users.json", "db/config.json", "db/metadata.db", "files/ab/doc.xml"},
            )
            manifest = json.loads(zf.read("backup-manifest.json"))
            self.assertEqual(manifest["format"], 1)
            self.assertEqual(manifest["pte_version"], "0.76.0")
            self.assertIn("created_at", manifest)
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


    def test_job_queue_files_are_excluded(self):
        from fastapi_app.plugins.backup_restore.archive import create_backup_zip

        for name in ("jobs.db", "jobs.db-wal", "jobs.db-shm"):
            (self.data / "db" / name).write_text("x")
        (self.data / "jobs" / "j1").mkdir(parents=True)
        (self.data / "jobs" / "j1" / "backup_old.zip").write_text("x")

        zip_path, _ = create_backup_zip(self.data, self.data / "jobs" / "j2", "0.76.0")
        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
        self.assertFalse([n for n in names if n.startswith("db/jobs.db")], names)
        self.assertFalse([n for n in names if n.startswith("jobs/")], names)
        self.assertIn("db/users.json", names)

    def test_progress_and_cancel(self):
        from fastapi_app.plugins.backup_restore.archive import create_backup_zip

        calls: list[tuple[int, int, str]] = []
        create_backup_zip(self.data, self.data / "tmp", "0.76.0", progress=lambda *a: calls.append(a))
        self.assertEqual([c[0] for c in calls], [1, 2, 3, 4])
        self.assertEqual({c[1] for c in calls}, {4})

        def cancel() -> None:
            raise RuntimeError("cancelled")

        out = self.data / "cancel"
        with self.assertRaises(RuntimeError):
            create_backup_zip(self.data, out, "0.76.0", check_cancelled=cancel)
        self.assertEqual(list(out.iterdir()), [])


class TestDownloadRoute(unittest.TestCase):
    """Test the download endpoint end to end with dependency overrides."""

    def setUp(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from fastapi_app.lib.core.dependencies import get_auth_manager, get_session_manager, get_sse_service
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
        app.dependency_overrides[get_sse_service] = lambda: MagicMock()
        self.client = TestClient(app)

        settings = MagicMock(
            data_root=self.data, tmp_dir=self.data / "tmp", session_timeout=3600,
            project_root_dir=Path(__file__).resolve().parents[4],
        )
        patcher = patch("fastapi_app.config.get_settings", return_value=settings)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.version = "0.76.2"
        version_patcher = patch(
            "fastapi_app.plugins.backup_restore.routes.get_pte_version", side_effect=lambda: self.version
        )
        version_patcher.start()
        self.addCleanup(version_patcher.stop)

    def tearDown(self):
        shutil.rmtree(self.root)

    def test_missing_session_is_401(self):
        r = self.client.get("/api/plugins/backup-restore/download")
        self.assertEqual(r.status_code, 401)

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

    def _restore(self, files: dict[str, str]):
        self.roles = ["restore"]
        return self.client.post(
            "/api/plugins/backup-restore/restore",
            headers={"X-Session-ID": "s"},
            files={"file": ("b.zip", _zip(self.root / "upload.zip", files).read_bytes())},
        )

    def test_restore_stages_and_recycles_workers(self):
        from fastapi_app.lib.core.data_restore import is_restore_pending
        from fastapi_app.lib.core.worker_recycle import recycle_workers
        from fastapi_app.plugins.backup_restore import routes

        with patch.dict("os.environ", {"PTE_WORKER_RECYCLE": "1"}), \
                patch.object(routes, "_schedule") as schedule, \
                patch.object(routes, "broadcast_to_all_sessions") as broadcast:
            r = self._restore({"backup-manifest.json": MANIFEST, "db/users.json": "[]", "db/config.json": "{}"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["supervised"])
        self.assertTrue(is_restore_pending(self.data))
        schedule.assert_called_once_with(routes.RESTART_DELAY_SECONDS, recycle_workers)
        self.assertEqual(broadcast.call_args.kwargs["event_type"], "maintenanceOn")
        self.assertEqual(list((self.data / "tmp").glob("restore_*")), [])

    def test_restore_without_supervisor_waits_for_manual_restart(self):
        from fastapi_app.lib.core.data_restore import is_restore_pending
        from fastapi_app.plugins.backup_restore import routes

        with patch.dict("os.environ", {"PTE_WORKER_RECYCLE": ""}), \
                patch.object(routes, "_is_supervised", return_value=False), \
                patch.object(routes, "_schedule") as schedule:
            r = self._restore({"backup-manifest.json": MANIFEST, "db/users.json": "[]", "db/config.json": "{}"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(r.json()["supervised"])
        self.assertTrue(is_restore_pending(self.data))
        schedule.assert_not_called()

    def test_restore_refuses_unsafe_paths(self):
        from fastapi_app.lib.core.data_restore import is_restore_pending

        r = self._restore({"backup-manifest.json": MANIFEST, "db/users.json": "[]", "db/config.json": "{}", "../../evil": "x"})
        self.assertEqual(r.status_code, 400)
        self.assertFalse(is_restore_pending(self.data))
        self.assertFalse((self.root.parent / "evil").exists())

    def test_downloaded_backup_restores_into_same_version(self):
        from fastapi_app.lib.core.data_restore import is_restore_pending
        from fastapi_app.plugins.backup_restore import routes

        r = self.client.get("/api/plugins/backup-restore/download", headers={"X-Session-ID": "s"})
        self.assertEqual(r.status_code, 200)
        with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
            self.assertEqual(json.loads(zf.read("backup-manifest.json"))["pte_version"], "0.76.2")

        self.roles = ["restore"]
        with patch.object(routes, "can_recycle_workers", return_value=False), \
                patch.object(routes, "_is_supervised", return_value=False):
            r = self.client.post(
                "/api/plugins/backup-restore/restore",
                headers={"X-Session-ID": "s"},
                files={"file": ("b.zip", r.content)},
            )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(is_restore_pending(self.data))

    def test_restore_refuses_incompatible_version(self):
        from fastapi_app.lib.core.data_restore import is_restore_pending

        self.version = "0.77.0"
        r = self._restore({"backup-manifest.json": MANIFEST, "db/users.json": "[]", "db/config.json": "{}"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("0.76.0", r.json()["detail"])
        self.assertIn("0.77.0", r.json()["detail"])
        self.assertFalse(is_restore_pending(self.data))

    def test_restore_refuses_unversioned_backup(self):
        from fastapi_app.lib.core.data_restore import is_restore_pending

        r = self._restore({"db/users.json": "[]", "db/config.json": "{}"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("backup-manifest.json", r.json()["detail"])
        self.assertFalse(is_restore_pending(self.data))

    def test_restore_accepts_manifest_under_data_prefix(self):
        from fastapi_app.lib.core.data_restore import is_restore_pending
        from fastapi_app.plugins.backup_restore import routes

        with patch.object(routes, "can_recycle_workers", return_value=False), \
                patch.object(routes, "_is_supervised", return_value=False):
            r = self._restore({
                "data/backup-manifest.json": MANIFEST, "data/db/users.json": "[]", "data/db/config.json": "{}",
            })
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(is_restore_pending(self.data))

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


class TestBackupJob(unittest.TestCase):
    """Test the `backup-restore.backup` job type end to end on a job manager."""

    def setUp(self):
        import gc
        import os
        from contextlib import asynccontextmanager

        from fastapi import APIRouter, FastAPI
        from fastapi.testclient import TestClient
        from fastapi_jobqueue import MemoryJobStore

        from fastapi_app.config import get_settings
        from fastapi_app.lib.core.dependencies import get_auth_manager, get_session_manager
        from fastapi_app.lib.jobs import create_job_manager, set_job_manager
        from fastapi_app.lib.jobs import manager as manager_module
        from fastapi_app.lib.jobs.routes import include_job_routes
        from fastapi_app.plugins.backup_restore.plugin import register_job_types
        from fastapi_app.plugins.backup_restore.routes import router

        self.root = Path(tempfile.mkdtemp())
        self.data = self.root
        (self.data / "db").mkdir()
        (self.data / "files").mkdir()
        (self.data / "db" / "users.json").write_text("[]")
        (self.data / "db" / "config.json").write_text("{}")
        (self.data / "db" / "jobs.db").write_text("x")
        for i in range(3):
            (self.data / "files" / f"f{i}.xml").write_text("<TEI/>")

        env = patch.dict(os.environ, {"DATA_ROOT": str(self.data)})
        env.start()
        get_settings.cache_clear()
        self.saved_manager = manager_module._manager

        def cleanup() -> None:
            manager_module._manager = self.saved_manager
            env.stop()
            get_settings.cache_clear()
            gc.collect()
            shutil.rmtree(self.root, ignore_errors=True)

        self.addCleanup(cleanup)

        users = {
            "alice": {"username": "alice", "roles": ["backup"]},
            "bob": {"username": "bob", "roles": ["restore"]},
            "carol": {"username": "carol", "roles": ["backup"]},
        }
        sessions = {"alice-session": users["alice"], "bob-session": users["bob"], "carol-session": users["carol"]}
        session_manager = MagicMock()
        session_manager.is_session_valid.return_value = True
        auth_manager = MagicMock()
        auth_manager.get_user_by_session_id.side_effect = lambda sid, _sm: sessions.get(sid)
        auth_manager.get_user_by_username.side_effect = users.get
        auth_patch = patch("fastapi_app.lib.jobs.auth.get_auth_manager", lambda: auth_manager)
        auth_patch.start()
        self.addCleanup(auth_patch.stop)

        register_job_types()
        self.manager = create_job_manager(MemoryJobStore())
        self.manager.poll_interval = 0.05
        set_job_manager(self.manager)

        app = FastAPI(lifespan=self.manager.lifespan)
        api_v1 = APIRouter(prefix="/api/v1")
        include_job_routes(api_v1)
        app.include_router(api_v1)
        app.include_router(router)
        app.dependency_overrides[get_session_manager] = lambda: session_manager
        app.dependency_overrides[get_auth_manager] = lambda: auth_manager
        self.client = TestClient(app)
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def submit(self, session: str = "alice-session"):
        return self.client.post("/api/plugins/backup-restore/backup", headers={"X-Session-ID": session})

    def wait_for(self, job_id: str, statuses: tuple[str, ...]) -> dict:
        import time

        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            job = self.client.get(f"/api/v1/jobs/{job_id}", headers={"X-Session-ID": "alice-session"}).json()
            if job["status"] in statuses:
                return job
            time.sleep(0.02)
        self.fail(f"Job {job_id} did not reach {statuses}: {job}")

    def test_backup_job_produces_download(self):
        r = self.submit()
        self.assertEqual(r.status_code, 202, r.text)
        job = self.wait_for(r.json()["id"], ("done", "error"))
        self.assertEqual(job["status"], "done", job)
        result = job["result"]
        self.assertTrue(result["filename"].startswith("backup_") and result["filename"].endswith(".zip"))
        self.assertTrue(result["download"].startswith(f"/api/v1/jobs/{job['id']}/files/"))
        download = self.client.get(result["download"], headers={"X-Session-ID": "alice-session"})
        self.assertEqual(download.status_code, 200)
        self.assertEqual(hashlib.sha256(download.content).hexdigest(), result["sha256"])
        self.assertEqual(len(download.content), result["size"])
        with zipfile.ZipFile(io.BytesIO(download.content)) as zf:
            names = zf.namelist()
        self.assertIn("db/users.json", names)
        self.assertNotIn("db/jobs.db", names)
        self.assertFalse([n for n in names if n.startswith("jobs/")])

    def test_plugin_routes_status_and_streamed_file(self):
        base = "/api/plugins/backup-restore/backup"
        alice = {"X-Session-ID": "alice-session"}
        job_id = self.submit().json()["id"]
        job = self.wait_for(job_id, ("done", "error"))
        self.assertEqual(job["status"], "done", job)

        status = self.client.get(f"{base}/{job_id}", headers=alice)
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.json()["status"], "done")

        file = self.client.get(f"{base}/{job_id}/file", headers=alice)
        self.assertEqual(file.status_code, 200, file.text)
        self.assertEqual(file.headers["content-type"], "application/zip")
        self.assertIn(job["result"]["filename"], file.headers["content-disposition"])
        self.assertEqual(hashlib.sha256(file.content).hexdigest(), job["result"]["sha256"])

        other = {"X-Session-ID": "carol-session"}
        self.assertEqual(self.client.get(f"{base}/{job_id}/file", headers=other).status_code, 403)
        self.assertEqual(self.client.get(f"{base}/{job_id}", headers=other).status_code, 403)
        self.assertEqual(self.client.post(f"{base}/{job_id}/cancel", headers=other).status_code, 403)
        self.assertEqual(self.client.get(f"{base}/{job_id}/file", headers={"X-Session-ID": "bob-session"}).status_code, 403)
        self.assertEqual(self.client.get(f"{base}/nonexistent/file", headers=alice).status_code, 404)

    def test_plugin_file_route_unfinished_job_is_404_and_cancel_works(self):
        import threading

        from fastapi_app.plugins.backup_restore import archive

        started = threading.Event()
        release = threading.Event()
        original = archive.snapshot_sqlite

        def slow_snapshot(source: Path, target: Path) -> None:
            started.set()
            release.wait(10)
            original(source, target)

        sqlite3.connect(self.data / "db" / "metadata.db").close()
        base = "/api/plugins/backup-restore/backup"
        alice = {"X-Session-ID": "alice-session"}
        with patch.object(archive, "snapshot_sqlite", slow_snapshot):
            job_id = self.submit().json()["id"]
            self.assertTrue(started.wait(10))
            self.assertEqual(self.client.get(f"{base}/{job_id}/file", headers=alice).status_code, 404)
            self.assertEqual(self.client.post(f"{base}/{job_id}/cancel", headers=alice).status_code, 200)
            release.set()
            job = self.wait_for(job_id, ("cancelled", "done", "error"))
        self.assertEqual(job["status"], "cancelled")

    def test_backup_job_requires_role(self):
        self.assertEqual(self.submit("bob-session").status_code, 403)
        r = self.client.post(
            "/api/v1/jobs", json={"type": "backup-restore.backup"}, headers={"X-Session-ID": "bob-session"}
        )
        self.assertEqual(r.status_code, 403, r.text)

    def test_backup_job_cancel_leaves_no_file(self):
        import threading

        from fastapi_app.plugins.backup_restore import archive

        started = threading.Event()
        release = threading.Event()
        original = archive.snapshot_sqlite

        def slow_snapshot(source: Path, target: Path) -> None:
            started.set()
            release.wait(10)
            original(source, target)

        (self.data / "db" / "metadata.db").write_bytes(b"")
        sqlite3.connect(self.data / "db" / "metadata.db").close()
        with patch.object(archive, "snapshot_sqlite", slow_snapshot):
            job_id = self.submit().json()["id"]
            self.assertTrue(started.wait(10))
            cancel = self.client.post(f"/api/v1/jobs/{job_id}/cancel", headers={"X-Session-ID": "alice-session"})
            self.assertEqual(cancel.status_code, 200, cancel.text)
            release.set()
            job = self.wait_for(job_id, ("cancelled", "done", "error"))
        self.assertEqual(job["status"], "cancelled", job)
        out = self.data / "jobs" / job_id
        self.assertEqual(list(out.glob("*")) if out.exists() else [], [])


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
