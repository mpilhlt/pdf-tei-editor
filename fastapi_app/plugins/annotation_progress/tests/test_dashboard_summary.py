"""
Unit tests for the annotation progress dashboard summary route.

@testCovers fastapi_app/plugins/annotation_progress/routes.py
"""

import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import get_file_repository, require_authenticated_user
from fastapi_app.plugins.annotation_progress.routes import router
from fastapi_app.plugins.dashboard.tests.fixtures import TempFileRepository

LIFECYCLE = ["extraction", "draft", "in-review", "approved", "published"]
PROJECTS = [
    {"id": "p1", "name": "Project One", "members": ["alice"], "collections": ["c1"]},
    {"id": "p2", "name": "Empty", "members": ["alice"], "collections": ["c2"]},
    {"id": "p3", "name": "Everything", "members": ["bob"], "collections": ["*"]},
    {"id": "p4", "name": "Old", "members": ["bob"], "collections": ["c4"], "archived": True},
]
COLLECTIONS = [
    {"id": "c1", "name": "Batch one"},
    {"id": "c2", "name": "Batch two"},
    {"id": "c3", "name": "Batch three"},
    {"id": "c4", "name": "Archived batch"},
]


class TestDashboardSummary(unittest.TestCase):
    def setUp(self):
        self.files = TempFileRepository()
        self.addCleanup(self.files.cleanup)
        self.threshold = "approved"
        config = mock.MagicMock()
        config.get.side_effect = lambda key, default=None: {
            "annotation.lifecycle.order": LIFECYCLE,
            "plugin.annotation-progress.dashboard-threshold": self.threshold,
        }.get(key, default)
        patchers = [
            mock.patch("fastapi_app.config.get_settings", return_value=self.files.settings),
            mock.patch("fastapi_app.lib.utils.project_utils.get_projects_with_details", return_value=PROJECTS),
            mock.patch("fastapi_app.lib.utils.config_utils.get_config", return_value=config),
            mock.patch("fastapi_app.lib.utils.collection_utils.get_collections_with_details", return_value=COLLECTIONS),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

        app = FastAPI()
        app.include_router(router)
        self.user = {"username": "alice", "roles": ["user"]}
        app.dependency_overrides[require_authenticated_user] = lambda: self.user
        app.dependency_overrides[get_file_repository] = lambda: self.files.repo
        self.client = TestClient(app)

    def _get(self) -> dict:
        response = self.client.get("/api/plugins/annotation-progress/dashboard-summary")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_counts_documents_at_or_after_threshold_per_collection_and_variant(self):
        self.files.add("doc-a", "pdf", ["c1"])
        self.files.add("doc-a", collections=["c1"], status="draft", variant="v1")
        self.files.add("doc-a", collections=["c1"], status="approved", variant="v1")
        self.files.add("doc-a", collections=["c1"], status="draft", variant="v2")
        self.files.add("doc-b", "pdf", ["c1"])
        self.files.add("doc-b", collections=["c1"], status="published", variant="v1")
        self.files.add("doc-c", "pdf", ["c1"])
        self.files.add("doc-d", collections=["c1"], status="in-review", variant="v1")

        data = self._get()

        self.assertEqual(data["threshold"], "approved")
        self.assertEqual(data["projects"], [{"id": "p1", "name": "Project One", "batches": [{
            "id": "c1",
            "name": "Batch one",
            "total": 4,
            "variants": [{"variant": "v1", "done": 2}, {"variant": "v2", "done": 0}],
        }]}])

    def test_unknown_threshold_falls_back_to_last_status(self):
        self.threshold = "nonexistent"
        self.files.add("doc-a", collections=["c1"], status="approved", variant="v1")
        self.files.add("doc-b", collections=["c1"], status="published", variant="v1")

        data = self._get()

        self.assertEqual(data["threshold"], "published")
        self.assertEqual(data["projects"][0]["batches"][0]["variants"], [{"variant": "v1", "done": 1}])

    def test_lists_each_collection_once_and_skips_archived_collections(self):
        self.user = {"username": "admin", "roles": ["*"]}
        for collection in ["c1", "c3", "c4"]:
            self.files.add(f"doc-{collection}", collections=[collection], status="draft", variant="v1")

        data = self._get()

        self.assertEqual(
            [(p["id"], [b["id"] for b in p["batches"]]) for p in data["projects"]],
            [("p3", ["c3"]), ("p1", ["c1"])],
        )


if __name__ == "__main__":
    unittest.main()
