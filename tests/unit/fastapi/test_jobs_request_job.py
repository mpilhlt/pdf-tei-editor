"""
Unit tests for jobs that are driven by the request that does their work, and the thread adapters.

@testCovers fastapi_app/lib/jobs/request_job.py
@testCovers fastapi_app/lib/jobs/adapters.py
"""

import asyncio
import threading
import time
import unittest
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from fastapi_jobqueue import JobManager, Principal

from fastapi_app.lib.jobs import RequestJob, RequestJobCancelled, register_client_type, run_request_job, thread_callbacks
from tests.unit.fastapi.test_jobs_infrastructure import JobsTestCase, headers

register_client_type("test-request.job", title="Request job")

ALICE = Principal(id="alice", is_admin=False)
STARTED = threading.Event()


def loop_in_thread(check: Callable[[], None]) -> None:
    for _ in range(500):
        check()
        time.sleep(0.01)


class TestRequestJob(JobsTestCase):
    def make_request_client(self, manager: JobManager) -> TestClient:
        client = self.make_client(manager)
        app: FastAPI = client.app  # type: ignore[assignment]

        @app.post("/work/{job_id}/{mode}")
        async def work(job_id: str, mode: str) -> dict[str, Any]:
            try:
                async with run_request_job(job_id, ALICE) as job:
                    await self.run_mode(job, mode)
            except RequestJobCancelled:
                return {"cancelled": True}
            return {"ok": True}

        return client

    async def run_mode(self, job: RequestJob, mode: str) -> None:
        if mode == "ok":
            await job.report(done=1, total=4, unit="pages", phase="Reading")
            await job.report(done=2)
            job.set_result({"pages": 4})
        elif mode == "fail":
            raise HTTPException(status_code=422, detail="bad")
        elif mode == "sleep":
            STARTED.set()
            for _ in range(200):
                await asyncio.sleep(0.02)
                await job.report(message="working")
        elif mode == "thread":
            STARTED.set()
            await asyncio.to_thread(loop_in_thread, job.check_cancelled)

    def submit_client_job(self, client: TestClient) -> str:
        return self.submit(client, {"type": "test-request.job"})["id"]

    def run_in_thread(self, client: TestClient, job_id: str, mode: str) -> threading.Thread:
        thread = threading.Thread(target=lambda: client.post(f"/work/{job_id}/{mode}"))
        STARTED.clear()
        thread.start()
        return thread

    def test_request_job_reports_and_finishes(self) -> None:
        with self.make_request_client(self.make_manager()) as client:
            job_id = self.submit_client_job(client)
            response = client.post(f"/work/{job_id}/ok")
            self.assertEqual(response.status_code, 200, response.text)
            job = self.wait_for(client, job_id, ("done",))
        self.assertEqual(job["result"], {"pages": 4})
        self.assertEqual(job["progress"]["done"], 2)
        self.assertEqual(job["progress"]["total"], 4)
        self.assertEqual(job["progress"]["phase"], "Reading")
        self.assertEqual(job["progress"]["unit"], "pages")

    def test_request_job_cancel_between_reports(self) -> None:
        manager = self.make_manager()
        manager.lease_ttl = 0.3
        with self.make_request_client(manager) as client:
            job_id = self.submit_client_job(client)
            thread = self.run_in_thread(client, job_id, "sleep")
            self.assertTrue(STARTED.wait(5))
            response = client.post(f"/api/v1/jobs/{job_id}/cancel", headers=headers("alice-session"))
            self.assertEqual(response.status_code, 200, response.text)
            thread.join(10)
            job = self.wait_for(client, job_id, ("cancelled",))
        self.assertEqual(job["status"], "cancelled")

    def test_request_job_error_status(self) -> None:
        with self.make_request_client(self.make_manager()) as client:
            job_id = self.submit_client_job(client)
            response = client.post(f"/work/{job_id}/fail")
            job = self.wait_for(client, job_id, ("error",))
        self.assertEqual(response.status_code, 422)
        self.assertEqual(job["error"]["status"], 422)

    def test_request_job_unknown_and_unclaimable(self) -> None:
        with self.make_request_client(self.make_manager()) as client:
            self.assertEqual(client.post("/work/nope/ok").status_code, 404)
            job_id = self.submit_client_job(client)
            self.assertEqual(client.post(f"/work/{job_id}/ok").status_code, 200)
            self.assertEqual(client.post(f"/work/{job_id}/ok").status_code, 409)

    def test_request_job_check_cancelled_from_thread(self) -> None:
        manager = self.make_manager()
        manager.lease_ttl = 0.3
        with self.make_request_client(manager) as client:
            job_id = self.submit_client_job(client)
            thread = self.run_in_thread(client, job_id, "thread")
            self.assertTrue(STARTED.wait(5))
            client.post(f"/api/v1/jobs/{job_id}/cancel", headers=headers("alice-session"))
            started = time.monotonic()
            thread.join(10)
            job = self.wait_for(client, job_id, ("cancelled",))
        # The thread loop would run 5 s if it were not stopped
        self.assertLess(time.monotonic() - started, 4)
        self.assertEqual(job["status"], "cancelled")


class TestThreadCallbacks(unittest.TestCase):
    def test_thread_callbacks_adapter(self) -> None:
        calls: list[dict[str, Any]] = []
        cancelled = False

        def check() -> None:
            if cancelled:
                raise RequestJobCancelled()

        progress, cancellation = thread_callbacks(lambda **fields: calls.append(fields), check)
        progress(3, 10, "x")
        self.assertEqual(calls, [{"done": 3, "total": 10, "phase": "x"}])
        self.assertFalse(cancellation())
        cancelled = True
        self.assertTrue(cancellation())


if __name__ == "__main__":
    unittest.main()
