"""
Unit tests for the review queue route.

@testCovers fastapi_app/plugins/review_queue/routes.py
@testCovers fastapi_app/lib/repository/file_repository.py
"""

import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import get_file_repository, require_authenticated_user
from fastapi_app.plugins.dashboard.tests.fixtures import TempFileRepository
from fastapi_app.plugins.review_queue.routes import router

PROJECTS = [
    {"id": "p1", "name": "Project One", "members": ["alice"], "collections": ["c1"]},
    {"id": "p2", "name": "Old", "members": ["bob"], "collections": ["c2"], "archived": True},
    {"id": "p3", "name": "Everything", "members": ["bob"], "collections": ["*"]},
]


class TestReviewQueueRoute(unittest.TestCase):
    def setUp(self):
        self.files = TempFileRepository()
        self.addCleanup(self.files.cleanup)
        self.statuses = ["in-review"]
        config = mock.MagicMock()
        config.get.side_effect = lambda key, default=None: self.statuses if key == "plugin.review-queue.statuses" else default
        patchers = [
            mock.patch("fastapi_app.config.get_settings", return_value=self.files.settings),
            mock.patch("fastapi_app.lib.utils.project_utils.get_projects_with_details", return_value=PROJECTS),
            mock.patch("fastapi_app.lib.utils.config_utils.get_config", return_value=config),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

        app = FastAPI()
        app.include_router(router)
        self.user = {"username": "alice", "roles": ["user", "reviewer"]}
        app.dependency_overrides[require_authenticated_user] = lambda: self.user
        app.dependency_overrides[get_file_repository] = lambda: self.files.repo
        self.client = TestClient(app)

    def _get(self) -> dict:
        response = self.client.get("/api/plugins/review-queue/documents")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_lists_accessible_documents_with_configured_status_newest_first(self):
        older = self.files.add("doc-a", collections=["c1"], status="in-review")
        newer = self.files.add("doc-b", collections=["c1"], status="in-review")
        self.files.add("doc-c", collections=["c1"], status="draft")
        self.files.add("doc-d", collections=["c9"], status="in-review")
        self.files.set_updated_at(older.stable_id, "2026-10-01 10:00:00")
        self.files.set_updated_at(newer.stable_id, "2026-10-02 10:00:00")

        data = self._get()

        self.assertEqual(data["statuses"], ["in-review"])
        self.assertEqual([d["doc_id"] for d in data["documents"]], ["doc-b", "doc-a"])
        self.assertEqual(data["documents"][0]["project"], "Project One")

    def test_skips_documents_whose_latest_version_has_moved_on(self):
        reviewed = self.files.add("doc-a", collections=["c1"], status="in-review")
        approved = self.files.add("doc-a", collections=["c1"], status="approved")
        self.files.set_updated_at(reviewed.stable_id, "2026-10-01 10:00:00")
        self.files.set_updated_at(approved.stable_id, "2026-10-02 10:00:00")

        self.assertEqual(self._get()["documents"], [])

    def test_lists_each_variant_separately_and_supports_several_statuses(self):
        self.statuses = ["in-review", "checked"]
        self.files.add("doc-a", collections=["c1"], status="in-review", variant="v1")
        self.files.add("doc-a", collections=["c1"], status="checked", variant="v2")

        documents = self._get()["documents"]

        self.assertEqual(sorted(d["variant"] for d in documents), ["v1", "v2"])

    def test_skips_documents_of_archived_projects(self):
        self.user = {"username": "admin", "roles": ["*"]}
        self.files.add("doc-a", collections=["c2"], status="in-review")
        self.files.add("doc-b", collections=["c1"], status="in-review")

        self.assertEqual([d["doc_id"] for d in self._get()["documents"]], ["doc-b"])

    def test_returns_nothing_for_users_without_reviewer_role(self):
        self.user = {"username": "alice", "roles": ["user", "annotator"]}
        self.files.add("doc-a", collections=["c1"], status="in-review")
        self.assertEqual(self._get()["documents"], [])

    def test_returns_nothing_without_configured_statuses(self):
        self.statuses = []
        self.files.add("doc-a", collections=["c1"], status="in-review")
        self.assertEqual(self._get()["documents"], [])


if __name__ == "__main__":
    unittest.main()
