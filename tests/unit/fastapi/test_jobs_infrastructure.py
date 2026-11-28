"""
Unit tests for the job infrastructure: the manager on fastapi-jobqueue, the editor's authentication, the file-lock resources, the job type registry and the job routes.

@testCovers fastapi_app/lib/jobs/manager.py
@testCovers fastapi_app/lib/jobs/auth.py
@testCovers fastapi_app/lib/jobs/hooks.py
@testCovers fastapi_app/lib/jobs/registry.py
@testCovers fastapi_app/lib/jobs/files.py
@testCovers fastapi_app/lib/jobs/routes.py
@testCovers fastapi_app/lib/jobs/core_types.py
"""

import asyncio
import gc
import logging
import os
import shutil
import tempfile
import threading
import time
import unittest
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from fastapi_jobqueue import JobContext, JobManager, MemoryJobStore, SqliteJobStore
from pydantic import BaseModel

from fastapi_app.config import get_settings
from fastapi_app.lib.core import locking
from fastapi_app.lib.core.db_utils import close_all_connections
from fastapi_app.lib.core.dependencies import get_auth_manager, get_session_manager
from fastapi_app.lib.core.locking import acquire_lock, check_lock, release_lock, reset_locks_db_initialized
from fastapi_app.lib.jobs import (
    create_job_manager,
    job_lock_refresher,
    job_output_dir,
    job_type,
    job_types,
    register_client_type,
    set_job_manager,
)
from fastapi_app.lib.jobs import core_types  # noqa: F401  (registers test.progress)
from fastapi_app.lib.jobs import manager as manager_module
from fastapi_app.lib.jobs.routes import include_job_routes

ADMIN = {"username": "admin", "roles": ["admin"]}
ALICE = {"username": "alice", "roles": ["annotator"]}
BOB = {"username": "bob", "roles": ["annotator"]}
USERS = {"admin": ADMIN, "alice": ALICE, "bob": BOB}
SESSIONS = {"admin-session": ADMIN, "alice-session": ALICE, "bob-session": BOB}

logger = logging.getLogger(__name__)

# Gates that the test handlers wait for, by name
GATES: dict[str, threading.Event] = {}


class GateParams(BaseModel):
    gate: str
    fail: bool = False
    seconds: float = 0


@job_type("test-infra.admin-only", title="Admin only", roles=["admin"])
async def run_admin_only(ctx: JobContext, params: Any) -> dict[str, Any]:
    return {}


@job_type("test-infra.hold", title="Hold a file", params_model=GateParams)
async def run_hold(ctx: JobContext, params: GateParams) -> dict[str, Any]:
    """Waits until its gate is set (or `seconds` passed), then fails if asked to."""
    gate = GATES.setdefault(params.gate, threading.Event())
    started = time.monotonic()
    while not gate.is_set() and (not params.seconds or time.monotonic() - started < params.seconds):
        ctx.check_cancelled()
        await asyncio.sleep(0.02)
    if params.fail:
        raise RuntimeError("Hold failed")
    return {"held": True}


# One at a time, so that a second job waits in "queued"
job_type("test-infra.single", title="Hold a file, one at a time", params_model=GateParams, max_concurrent=1)(run_hold)


@job_type("test-infra.write-file", title="Write a file")
async def run_write_file(ctx: JobContext, params: Any) -> dict[str, Any]:
    (job_output_dir(ctx.job_id) / "x.txt").write_text("content")
    return {}


class FakeFileRepository:
    """Stands in for the file repository of `EditorJobHooks`: every stable id names a file except those that start with `missing`."""

    def get_file_by_stable_id(self, stable_id: str) -> SimpleNamespace | None:
        return None if stable_id.startswith("missing") else SimpleNamespace(stable_id=stable_id)


def fake_check_file_access(file: SimpleNamespace, user: dict[str, Any], operation: str) -> bool:
    """Files whose stable id starts with `readonly` cannot be edited by non-admins."""
    return user["username"] == "admin" or not file.stable_id.startswith("readonly")


def headers(session: str) -> dict[str, str]:
    return {"X-Session-ID": session}


class JobsTestCase(unittest.TestCase):
    """A temp data root, mocked authentication and an app with the job routes on a fresh manager."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.db_dir = self.tmp / "db"
        self.db_dir.mkdir()
        self.env = patch.dict(os.environ, {"DATA_ROOT": str(self.tmp)})
        self.env.start()
        get_settings.cache_clear()
        reset_locks_db_initialized()
        self.saved_manager = manager_module._manager

        self.session_manager = MagicMock()
        self.session_manager.is_session_valid.return_value = True
        self.auth_manager = MagicMock()
        self.auth_manager.get_user_by_session_id.side_effect = lambda session_id, _sm: SESSIONS.get(session_id)
        self.auth_manager.get_user_by_username.side_effect = USERS.get
        self.auth_patch = patch("fastapi_app.lib.jobs.auth.get_auth_manager", lambda: self.auth_manager)
        self.auth_patch.start()
        # Files of the `file:` resources: every id names a file except `missing*`; `readonly*` files cannot be edited
        self.files_patches = [
            patch("fastapi_app.lib.jobs.hooks._file_repository", FakeFileRepository),
            patch("fastapi_app.lib.jobs.hooks.check_file_access", fake_check_file_access),
        ]
        for files_patch in self.files_patches:
            files_patch.start()

    def tearDown(self) -> None:
        for files_patch in self.files_patches:
            files_patch.stop()
        self.auth_patch.stop()
        manager_module._manager = self.saved_manager
        self.env.stop()
        get_settings.cache_clear()
        reset_locks_db_initialized()
        close_all_connections()
        gc.collect()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def make_manager(self, store: SqliteJobStore | None = None) -> JobManager:
        manager = create_job_manager(store or MemoryJobStore())
        manager.poll_interval = 0.05
        return manager

    def make_client(self, manager: JobManager) -> TestClient:
        set_job_manager(manager)

        @asynccontextmanager
        async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
            async with manager.lifespan(), job_lock_refresher(interval=0.2):
                yield

        app = FastAPI(lifespan=lifespan)
        api_v1 = APIRouter(prefix="/api/v1")
        include_job_routes(api_v1)
        app.include_router(api_v1)
        app.dependency_overrides[get_session_manager] = lambda: self.session_manager
        app.dependency_overrides[get_auth_manager] = lambda: self.auth_manager
        return TestClient(app)

    def submit(self, client: TestClient, body: dict[str, Any], session: str = "alice-session") -> dict[str, Any]:
        response = client.post("/api/v1/jobs", json=body, headers=headers(session))
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def wait_for(self, client: TestClient, job_id: str, statuses: tuple[str, ...], timeout: float = 5.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        job: dict[str, Any] = {}
        while time.monotonic() < deadline:
            job = client.get(f"/api/v1/jobs/{job_id}", headers=headers("admin-session")).json()
            if job.get("status") in statuses:
                return job
            time.sleep(0.02)
        self.fail(f"Job {job_id} did not reach {statuses}: {job}")

    def lock_of(self, stable_id: str) -> locking.LockStatus:
        return check_lock(stable_id, "other-session", self.db_dir, logger)


class TestJobsInfrastructure(JobsTestCase):
    def test_submit_and_finish_test_progress(self) -> None:
        with self.make_client(self.make_manager()) as client:
            job = self.submit(client, {"type": "test.progress", "params": {"steps": 2, "delay_ms": 1}})
            done = self.wait_for(client, job["id"], ("done", "error"))
        self.assertEqual(done["status"], "done")
        self.assertEqual(done["result"], {"steps": 2})
        self.assertEqual(done["progress"]["unit"], "steps")

    def test_test_progress_stands_in_for_other_jobs(self) -> None:
        with self.make_client(self.make_manager()) as client:
            job = self.submit(client, {"type": "test.progress", "params": {"steps": 1, "delay_ms": 1, "phase": "Recognizing text", "unit": "page", "result": {"changed": True}}})
            done = self.wait_for(client, job["id"], ("done", "error"))
            self.assertEqual((done["result"], done["progress"]["phase"], done["progress"]["unit"]), ({"changed": True}, "Recognizing text", "page"))
            # with cancel_result, a cancel ends the job done with that result
            job = self.submit(client, {"type": "test.progress", "params": {"steps": 100, "delay_ms": 50, "cancel_result": {"cancelled": True}}})
            self.wait_for(client, job["id"], ("active",))
            client.post(f"/api/v1/jobs/{job['id']}/cancel", headers=headers("alice-session"))
            done = self.wait_for(client, job["id"], ("done", "cancelled", "error"))
        self.assertEqual((done["status"], done["result"]), ("done", {"cancelled": True}))

    def test_types_route_lists_titles(self) -> None:
        with self.make_client(self.make_manager()) as client:
            response = client.get("/api/v1/jobs/types", headers=headers("alice-session"))
        self.assertEqual(response.status_code, 200)
        self.assertIn({"name": "test.progress", "title": "Progress test", "driver": "server", "roles": None}, response.json())

    def test_may_submit_respects_roles(self) -> None:
        with self.make_client(self.make_manager()) as client:
            refused = client.post("/api/v1/jobs", json={"type": "test-infra.admin-only"}, headers=headers("alice-session"))
            self.assertEqual(refused.status_code, 403, refused.text)
            accepted = client.post("/api/v1/jobs", json={"type": "test-infra.admin-only"}, headers=headers("admin-session"))
            self.assertEqual(accepted.status_code, 201, accepted.text)

    def test_cancel_from_store_stops_job(self) -> None:
        path = self.tmp / "jobs.db"
        manager_a = self.make_manager(SqliteJobStore(path))
        manager_b = self.make_manager(SqliteJobStore(path))
        with self.make_client(manager_a) as client:
            job = self.submit(client, {"type": "test.progress", "params": {"steps": 100, "delay_ms": 100}})
            self.wait_for(client, job["id"], ("active",))
            assert client.portal is not None
            client.portal.call(manager_b.cancel, job["id"])
            cancelled = self.wait_for(client, job["id"], ("cancelled", "done", "error"))
        self.assertEqual(cancelled["status"], "cancelled")

    def test_file_resource_locks_and_releases(self) -> None:
        with self.make_client(self.make_manager()) as client:
            for case, expected in (("done", "done"), ("fail", "error"), ("cancel", "cancelled")):
                with self.subTest(case=case):
                    stable_id = f"file-{case}"
                    gate = f"gate-{case}"
                    job = self.submit(client, {"type": "test-infra.hold", "params": {"gate": gate, "fail": case == "fail"}, "resources": [f"file:{stable_id}"]})
                    self.wait_for(client, job["id"], ("active",))
                    self.assertEqual(self.lock_of(stable_id), {"is_locked": True, "locked_by": f"job:{job['id']}"})
                    if case == "cancel":
                        response = client.post(f"/api/v1/jobs/{job['id']}/cancel", headers=headers("alice-session"))
                        self.assertEqual(response.status_code, 200, response.text)
                    else:
                        GATES.setdefault(gate, threading.Event()).set()
                    if case == "fail":
                        with self.assertLogs("fastapi_jobqueue.manager", level="ERROR"):
                            finished = self.wait_for(client, job["id"], ("done", "error", "cancelled"))
                    else:
                        finished = self.wait_for(client, job["id"], ("done", "error", "cancelled"))
                    self.assertEqual(finished["status"], expected)
                    self.assertEqual(self.lock_of(stable_id), {"is_locked": False, "locked_by": None})

    def test_lock_renewed_past_timeout(self) -> None:
        # The lock timestamps have a resolution of one second, so the timeout is 2 s rather than 1 s:
        # with 1 s, a lock renewed a moment ago can already look stale
        manager = self.make_manager()
        manager.lease_ttl = 0.3
        with patch.object(locking, "LOCK_TIMEOUT_SECONDS", 2), self.make_client(manager) as client:
            job = self.submit(client, {"type": "test-infra.hold", "params": {"gate": "gate-renew", "seconds": 4}, "resources": ["file:renewed"]})
            self.wait_for(client, job["id"], ("active",))
            time.sleep(3)
            self.assertFalse(acquire_lock("renewed", "other-session", self.db_dir, logger))
            GATES.setdefault("gate-renew", threading.Event()).set()
            self.wait_for(client, job["id"], ("done",))

    def test_queued_job_keeps_lock_past_timeout(self) -> None:
        with patch.object(locking, "LOCK_TIMEOUT_SECONDS", 2), self.make_client(self.make_manager()) as client:
            first = self.submit(client, {"type": "test-infra.single", "params": {"gate": "gate-first"}})
            self.wait_for(client, first["id"], ("active",))
            waiting = self.submit(client, {"type": "test-infra.single", "params": {"gate": "gate-waiting"}, "resources": ["file:waiting"]})
            time.sleep(3)
            self.assertEqual(client.get(f"/api/v1/jobs/{waiting['id']}", headers=headers("alice-session")).json()["status"], "queued")
            self.assertFalse(acquire_lock("waiting", "other-session", self.db_dir, logger))
            GATES.setdefault("gate-first", threading.Event()).set()
            GATES.setdefault("gate-waiting", threading.Event()).set()
            self.wait_for(client, waiting["id"], ("done",))

    def test_lost_lock_cancels_active_job(self) -> None:
        manager = self.make_manager()
        manager.lease_ttl = 0.3
        with self.make_client(manager) as client:
            job = self.submit(client, {"type": "test-infra.hold", "params": {"gate": "gate-lost"}, "resources": ["file:lost"]})
            self.wait_for(client, job["id"], ("active",))
            with self.assertLogs("fastapi_app.lib.jobs.hooks", level="WARNING") as logs:
                # another session takes the file, e.g. after the job's lock went stale
                release_lock("lost", f"job:{job['id']}", self.db_dir, logger)
                self.assertTrue(acquire_lock("lost", "other-session", self.db_dir, logger))
                finished = self.wait_for(client, job["id"], ("done", "error", "cancelled"))
        self.assertEqual(finished["status"], "cancelled")
        self.assertTrue(any("lost the lock of lost" in line for line in logs.output))
        self.assertEqual(check_lock("lost", "x", self.db_dir, logger), {"is_locked": True, "locked_by": "other-session"})

    def test_registering_a_type_again_replaces_it(self) -> None:
        async def first(ctx: JobContext, params: Any) -> str:
            return "first"

        async def second(ctx: JobContext, params: Any) -> str:
            return "second"

        with self.make_client(self.make_manager()) as client:
            job_type("test-infra.replaced", title="First")(first)
            job_type("test-infra.replaced", title="Second")(second)
            register_client_type("test-infra.client-replaced", title="Client first")
            register_client_type("test-infra.client-replaced", title="Client second")
            titles = {info.name: info.title for info in job_types()}
            self.assertEqual(titles["test-infra.replaced"], "Second")
            self.assertEqual(titles["test-infra.client-replaced"], "Client second")
            job = self.submit(client, {"type": "test-infra.replaced"})
            self.assertEqual(self.wait_for(client, job["id"], ("done",))["result"], "second")

    def test_busy_resource_returns_409(self) -> None:
        self.assertTrue(acquire_lock("busy", "alice-session", self.db_dir, logger))
        with self.make_client(self.make_manager()) as client:
            response = client.post(
                "/api/v1/jobs",
                json={"type": "test-infra.hold", "params": {"gate": "gate-busy"}, "resources": ["file:free", "file:busy"]},
                headers=headers("alice-session"),
            )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn("busy is being edited by another user or job", response.json()["detail"])
        # the lock taken before the refusal was given back
        self.assertEqual(self.lock_of("free"), {"is_locked": False, "locked_by": None})

    def test_resources_are_checked_on_submit(self) -> None:
        cases = (
            # the OCR engine lock and other local resources are not files
            ("file:local:ocr-engine", 400, "is not a file"),
            ("file:missing-file", 400, "File not found: missing-file"),
            ("file:readonly-file", 403, "Not allowed to lock readonly-file"),
        )
        with self.make_client(self.make_manager()) as client:
            for resource, status, detail in cases:
                with self.subTest(resource=resource):
                    response = client.post("/api/v1/jobs", json={"type": "test.progress", "params": {"steps": 1000000}, "resources": ["file:free-before", resource]}, headers=headers("alice-session"))
                    self.assertEqual(response.status_code, status, response.text)
                    self.assertIn(detail, response.json()["detail"])
                    self.assertEqual(self.lock_of(resource[len("file:"):]), {"is_locked": False, "locked_by": None})
                    self.assertEqual(self.lock_of("free-before"), {"is_locked": False, "locked_by": None})
            self.assertEqual(client.get("/api/v1/jobs", headers=headers("alice-session")).json(), [])
            # an admin may edit the file, so the same submit is accepted
            job = self.submit(client, {"type": "test.progress", "params": {"steps": 1, "delay_ms": 1}, "resources": ["file:readonly-file"]}, session="admin-session")
            self.wait_for(client, job["id"], ("done",))

    def test_deleted_hook_removes_output_dir(self) -> None:
        with self.make_client(self.make_manager()) as client:
            job = self.submit(client, {"type": "test-infra.write-file"})
            self.wait_for(client, job["id"], ("done",))
            output = get_settings().data_root / "jobs" / job["id"]
            self.assertTrue((output / "x.txt").is_file())
            response = client.delete(f"/api/v1/jobs/{job['id']}", headers=headers("alice-session"))
            self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(output.exists())

    def test_job_file_route(self) -> None:
        with self.make_client(self.make_manager()) as client:
            job = self.submit(client, {"type": "test-infra.write-file"})
            self.wait_for(client, job["id"], ("done",))
            url = f"/api/v1/jobs/{job['id']}/files"
            owner = client.get(f"{url}/x.txt", headers=headers("alice-session"))
            self.assertEqual(owner.status_code, 200)
            self.assertEqual(owner.text, "content")
            self.assertEqual(client.get(f"{url}/x.txt", headers=headers("bob-session")).status_code, 404)
            self.assertEqual(client.get(f"{url}/..%2Fx", headers=headers("alice-session")).status_code, 404)
            self.assertEqual(client.get(f"{url}/missing.txt", headers=headers("alice-session")).status_code, 404)


    def test_jobs_of_other_users_are_private(self) -> None:
        with self.make_client(self.make_manager()) as client:
            job = self.submit(client, {"type": "test.progress", "params": {"steps": 100, "delay_ms": 50}})
            self.wait_for(client, job["id"], ("active",))
            url = f"/api/v1/jobs/{job['id']}"
            self.assertEqual(client.get(url, headers=headers("bob-session")).status_code, 404)
            self.assertEqual(client.get("/api/v1/jobs", headers=headers("bob-session")).json(), [])
            self.assertEqual(client.get("/api/v1/jobs", headers=headers("alice-session")).json()[0]["id"], job["id"])
            # an invisible job is reported as missing, for cancel and delete too
            self.assertEqual(client.post(f"{url}/cancel", headers=headers("bob-session")).status_code, 404)
            self.assertEqual(client.delete(url, headers=headers("bob-session")).status_code, 404)
            self.assertEqual(client.get(url, headers=headers("alice-session")).json()["status"], "active")
            client.post(f"{url}/cancel", headers=headers("alice-session"))

    def test_shared_job_visible_but_not_cancellable_by_others(self) -> None:
        with self.make_client(self.make_manager()) as client:
            job = self.submit(client, {"type": "test.progress", "params": {"steps": 100, "delay_ms": 50}, "visibility": "users"})
            self.wait_for(client, job["id"], ("active",))
            url = f"/api/v1/jobs/{job['id']}"
            self.assertEqual(client.get(url, headers=headers("bob-session")).status_code, 200)
            self.assertEqual(client.post(f"{url}/cancel", headers=headers("bob-session")).status_code, 403)
            self.assertEqual(client.delete(url, headers=headers("bob-session")).status_code, 403)
            client.post(f"{url}/cancel", headers=headers("alice-session"))

    def test_admin_lists_cancels_and_deletes_jobs_of_others(self) -> None:
        with self.make_client(self.make_manager()) as client:
            job = self.submit(client, {"type": "test.progress", "params": {"steps": 100, "delay_ms": 50}})
            self.wait_for(client, job["id"], ("active",))
            url = f"/api/v1/jobs/{job['id']}"
            listed = client.get("/api/v1/jobs", headers=headers("admin-session")).json()
            self.assertEqual([(j["id"], j["owner"]) for j in listed], [(job["id"], "alice")])
            self.assertEqual(client.get("/api/v1/jobs", params={"mine": "true"}, headers=headers("admin-session")).json(), [])
            self.assertEqual(client.post(f"{url}/cancel", headers=headers("admin-session")).status_code, 200)
            self.assertEqual(self.wait_for(client, job["id"], ("cancelled", "done", "error"))["status"], "cancelled")
            self.assertEqual(client.delete(url, headers=headers("admin-session")).status_code, 200)
            self.assertEqual(client.get(url, headers=headers("admin-session")).status_code, 404)
            self.assertEqual(client.get("/api/v1/jobs", headers=headers("admin-session")).json(), [])

    def test_bulk_operations_are_admin_only(self) -> None:
        with self.make_client(self.make_manager()) as client:
            job = self.submit(client, {"type": "test.progress", "params": {"steps": 100, "delay_ms": 50}})
            self.wait_for(client, job["id"], ("active",))
            self.assertEqual(client.post("/api/v1/jobs/cancel-all", json={}, headers=headers("alice-session")).status_code, 403)
            self.assertEqual(client.delete("/api/v1/jobs", headers=headers("alice-session")).status_code, 403)
            response = client.post("/api/v1/jobs/cancel-all", json={}, headers=headers("admin-session"))
            self.assertEqual((response.status_code, response.json()), (200, {"count": 1}))
            self.assertEqual(self.wait_for(client, job["id"], ("cancelled", "done", "error"))["status"], "cancelled")

    def test_cancelling_a_finished_job_returns_it_unchanged(self) -> None:
        with self.make_client(self.make_manager()) as client:
            job = self.submit(client, {"type": "test.progress", "params": {"steps": 1, "delay_ms": 1}})
            done = self.wait_for(client, job["id"], ("done", "error"))
            for session in ("alice-session", "admin-session"):
                response = client.post(f"/api/v1/jobs/{job['id']}/cancel", headers=headers(session))
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual((response.json()["status"], response.json()["result"]), ("done", done["result"]))
            # the owner may delete the finished job
            self.assertEqual(client.delete(f"/api/v1/jobs/{job['id']}", headers=headers("alice-session")).status_code, 200)

    def test_non_admin_cannot_delete_unfinished_job(self) -> None:
        with self.make_client(self.make_manager()) as client:
            job = self.submit(client, {"type": "test.progress", "params": {"steps": 100, "delay_ms": 50}})
            self.wait_for(client, job["id"], ("active",))
            self.assertEqual(client.delete(f"/api/v1/jobs/{job['id']}", headers=headers("alice-session")).status_code, 409)
            client.post(f"/api/v1/jobs/{job['id']}/cancel", headers=headers("alice-session"))


if __name__ == "__main__":
    unittest.main()
