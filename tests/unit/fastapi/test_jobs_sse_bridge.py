"""
Unit tests for the bridge that forwards job events to the editor's SSE streams.

@testCovers fastapi_app/lib/jobs/sse_bridge.py
"""

import asyncio
import json
import unittest

from fastapi_jobqueue import JobEvent, MemoryJobStore, Progress

from fastapi_app.lib.core.sessions import SessionDict
from fastapi_app.lib.jobs import create_job_manager
from fastapi_app.lib.jobs import core_types  # noqa: F401  (registers test.progress)
from fastapi_app.lib.jobs.sse_bridge import JOB_EVENT, RESYNC_EVENT, JobSseBridge, deliver

ADMINS = {"admin"}


class FakeSse:
    """Records the messages sent; `active` are the sessions whose stream this worker serves."""

    def __init__(self, active: list[str]) -> None:
        self.active = active
        self.sent: list[tuple[str, str, str]] = []

    def get_active_clients(self) -> list[str]:
        return list(self.active)

    def send_message(self, client_id: str, event_type: str, data: str) -> bool:
        self.sent.append((client_id, event_type, data))
        return True


class FakeSessions:
    def __init__(self, sessions: dict[str, str]) -> None:
        self.sessions = sessions

    def get_all_sessions(self) -> list[SessionDict]:
        return [SessionDict(session_id=sid, username=user, created_at=0.0, last_access=0.0, token_id=None, expires_at=None) for sid, user in self.sessions.items()]


def make_event(job_id: str = "j1") -> JobEvent:
    return JobEvent(id=1, seq=1, job_id=job_id, type="test.progress", status="active", progress=Progress(), cancel_requested=False, at="2026-11-27T00:00:00Z")


SESSIONS = FakeSessions({"alice-1": "alice", "alice-2": "alice", "bob-1": "bob", "admin-1": "admin"})


def recipients(sse: FakeSse, event_type: str = JOB_EVENT) -> set[str]:
    return {client for client, kind, _data in sse.sent if kind == event_type}


class TestDeliver(unittest.TestCase):
    def test_owner_sessions_and_admins_receive_an_owner_job(self) -> None:
        sse = FakeSse(["alice-1", "alice-2", "bob-1", "admin-1"])
        deliver([(make_event(), "alice", "owner")], sse, SESSIONS, lambda u: u in ADMINS)
        self.assertEqual(recipients(sse), {"alice-1", "alice-2", "admin-1"})

    def test_everyone_receives_a_job_shared_with_users(self) -> None:
        sse = FakeSse(["alice-1", "bob-1", "admin-1"])
        deliver([(make_event(), "alice", "users")], sse, SESSIONS, lambda u: u in ADMINS)
        self.assertEqual(recipients(sse), {"alice-1", "bob-1", "admin-1"})

    def test_only_sessions_with_a_stream_in_this_worker(self) -> None:
        sse = FakeSse(["alice-2"])
        deliver([(make_event(), "alice", "owner")], sse, SESSIONS, lambda u: u in ADMINS)
        self.assertEqual(recipients(sse), {"alice-2"})

    def test_data_is_the_event_with_the_owner(self) -> None:
        sse = FakeSse(["alice-1"])
        deliver([(make_event("abc"), "alice", "owner")], sse, SESSIONS, lambda u: False)
        data = json.loads(sse.sent[0][2])
        self.assertEqual(data["job_id"], "abc")
        self.assertEqual(data["status"], "active")
        self.assertEqual(data["owner"], "alice")
        self.assertIn("progress", data)

    def test_resync_goes_to_every_session_first(self) -> None:
        sse = FakeSse(["alice-1", "bob-1"])
        deliver([(make_event(), "alice", "owner")], sse, SESSIONS, lambda u: False, resync=True)
        self.assertEqual(recipients(sse, RESYNC_EVENT), {"alice-1", "bob-1"})
        self.assertEqual(sse.sent[0][1], RESYNC_EVENT)

    def test_admin_lookup_once_per_user(self) -> None:
        sse = FakeSse(["alice-1", "alice-2", "bob-1"])
        calls: list[str] = []
        deliver([(make_event("a"), "bob", "owner"), (make_event("b"), "bob", "owner")], sse, SESSIONS, lambda u: calls.append(u) or False)
        self.assertEqual(sorted(calls), ["alice", "bob"])


class TestBridge(unittest.TestCase):
    def test_forwards_the_events_of_a_job_to_its_owner(self) -> None:
        sse = FakeSse(["alice-1", "bob-1"])

        async def scenario() -> None:
            manager = create_job_manager(MemoryJobStore())
            async with manager.lifespan():
                bridge = JobSseBridge(manager, sse, SESSIONS, lambda u: False)
                task = asyncio.create_task(bridge.run())
                try:
                    await asyncio.sleep(0.05)
                    job = await manager.submit("test.progress", {"steps": 2, "delay_ms": 10}, owner="alice")
                    for _ in range(200):
                        statuses = [json.loads(d)["status"] for c, k, d in sse.sent if k == JOB_EVENT]
                        if "done" in statuses:
                            break
                        await asyncio.sleep(0.02)
                    self.assertIn("done", statuses)
                    self.assertTrue(all(json.loads(d)["job_id"] == job.id for _c, _k, d in sse.sent))
                finally:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

        asyncio.run(scenario())
        self.assertEqual(recipients(sse), {"alice-1"})

    def test_overflow_drops_events_and_resyncs(self) -> None:
        sse = FakeSse(["alice-1"])

        async def scenario() -> None:
            manager = create_job_manager(MemoryJobStore())
            bridge = JobSseBridge(manager, sse, SESSIONS, lambda u: False, queue_size=1)
            # the bus calls the filter; a full queue marks the overflow
            self.assertFalse(bridge._accept(make_event("a"), "alice", "owner"))
            self.assertFalse(bridge._accept(make_event("b"), "alice", "owner"))
            task = asyncio.create_task(bridge.run())
            try:
                for _ in range(100):
                    if sse.sent:
                        break
                    await asyncio.sleep(0.01)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

        asyncio.run(scenario())
        self.assertEqual([k for _c, k, _d in sse.sent], [RESYNC_EVENT, JOB_EVENT])


if __name__ == "__main__":
    unittest.main()
