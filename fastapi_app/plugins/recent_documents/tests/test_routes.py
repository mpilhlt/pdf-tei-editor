"""
Unit tests for the recent documents route and the save event handler.

@testCovers fastapi_app/plugins/recent_documents/routes.py
@testCovers fastapi_app/plugins/recent_documents/plugin.py
@testCovers fastapi_app/plugins/dashboard/documents.py
"""

import asyncio
import unittest
from datetime import datetime, timezone
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import get_file_repository, require_authenticated_user
from fastapi_app.plugins.dashboard.tests.fixtures import TempFileRepository
from fastapi_app.plugins.recent_documents import edit_store
from fastapi_app.plugins.recent_documents.routes import router

PROJECTS = [
    {"id": "p1", "name": "Project One", "members": ["alice"], "collections": ["c1"]},
    {"id": "p2", "name": "Project Two", "members": ["alice"], "collections": ["c2"]},
    {"id": "p3", "name": "Archived", "members": ["alice"], "collections": ["c1"], "archived": True},
    {"id": "p4", "name": "Not mine", "members": ["bob"], "collections": ["c1"]},
    {"id": "p5", "name": "Everything", "members": ["bob"], "collections": ["*"]},
    {"id": "p6", "name": "Specific", "members": ["bob"], "collections": ["c3"]},
    {"id": "p7", "name": "Old", "members": ["bob"], "collections": ["c4"], "archived": True},
]


def _at(minute: int) -> datetime:
    return datetime(2026, 10, 19, 8, minute, tzinfo=timezone.utc)


class TestRecentDocumentsRoute(unittest.TestCase):
    def setUp(self):
        self.files = TempFileRepository()
        self.addCleanup(self.files.cleanup)
        patchers = [
            mock.patch("fastapi_app.config.get_settings", return_value=self.files.settings),
            mock.patch("fastapi_app.lib.utils.project_utils.get_projects_with_details", return_value=PROJECTS),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

        self.user = {"username": "alice", "roles": ["user"]}
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[require_authenticated_user] = lambda: self.user
        app.dependency_overrides[get_file_repository] = lambda: self.files.repo
        self.client = TestClient(app)

    def _edit(self, tei, minute: int) -> None:
        edit_store.record_edit("alice", tei.stable_id, self.files.settings.plugins_data_dir, _at(minute))

    def _get(self) -> list[dict]:
        response = self.client.get("/api/plugins/recent-documents/recent")
        self.assertEqual(response.status_code, 200)
        return response.json()["projects"]

    def test_groups_by_visible_project_sorted_by_latest_edit(self):
        pdf = self.files.add("doc-a", "pdf", ["c1"], title="Document A")
        a = self.files.add("doc-a", collections=["c1"], status="draft")
        b = self.files.add("doc-b", collections=["c2"])
        self._edit(a, 1)
        self._edit(b, 2)

        projects = self._get()

        self.assertEqual([p["id"] for p in projects], ["p2", "p1"])
        doc = projects[1]["documents"][0]
        self.assertEqual(doc["stable_id"], a.stable_id)
        self.assertEqual(doc["pdf_stable_id"], pdf.stable_id)
        self.assertEqual(doc["title"], "Document A")
        self.assertEqual(doc["status"], "draft")
        self.assertEqual(doc["edited_at"], _at(1).isoformat())

    def test_lists_at_most_five_documents_per_project_and_one_entry_per_document(self):
        for i in range(7):
            self._edit(self.files.add(f"doc-{i}", collections=["c1"]), i)
        newer_version = self.files.add("doc-6", collections=["c1"])
        self._edit(newer_version, 30)

        docs = self._get()[0]["documents"]

        self.assertEqual([d["doc_id"] for d in docs], ["doc-6", "doc-5", "doc-4", "doc-3", "doc-2"])
        self.assertEqual(docs[0]["stable_id"], newer_version.stable_id)

    def test_skips_deleted_files_and_inaccessible_collections(self):
        deleted = self.files.add("doc-x", collections=["c1"])
        self.files.repo.delete_file(deleted.id)
        foreign = self.files.add("doc-y", collections=["c9"])
        self._edit(deleted, 1)
        self._edit(foreign, 2)

        self.assertEqual(self._get(), [])

    def test_admin_sees_all_non_archived_projects(self):
        self.user = {"username": "alice", "roles": ["*"]}
        self._edit(self.files.add("doc-a", collections=["c2"]), 1)
        self._edit(self.files.add("doc-b", collections=["c3"]), 2)

        self.assertEqual([p["id"] for p in self._get()], ["p6", "p2"])

    def test_lists_a_document_only_under_the_most_specific_project(self):
        self.user = {"username": "alice", "roles": ["*"]}
        self._edit(self.files.add("doc-a", collections=["c3"]), 1)

        projects = self._get()

        self.assertEqual([p["id"] for p in projects], ["p6"])

    def test_returns_the_pdf_label_as_title_and_the_tei_label(self):
        self.files.add("doc-a", "pdf", ["c1"], title="Document A", label="PDF label")
        labelled = self.files.add("doc-a", collections=["c1"], label="TEI label")
        self._edit(labelled, 1)

        doc = self._get()[0]["documents"][0]

        self.assertEqual((doc["title"], doc["label"]), ("PDF label", "TEI label"))

    def test_skips_documents_of_archived_projects(self):
        self.user = {"username": "alice", "roles": ["*"]}
        self._edit(self.files.add("doc-a", collections=["c4"]), 1)
        shared = self.files.add("doc-b", collections=["c4", "c3"])
        self._edit(shared, 2)

        projects = self._get()

        self.assertEqual([d["doc_id"] for p in projects for d in p["documents"]], ["doc-b"])
        self.assertEqual(projects[0]["documents"][0]["collections"], ["c3"])


class TestSaveEventHandler(unittest.TestCase):
    def test_records_saves_and_seeds_from_creators(self):
        files = TempFileRepository()
        self.addCleanup(files.cleanup)
        created = files.add("doc-a", collections=["c1"])
        with files.db.get_connection() as conn:
            conn.execute("UPDATE files SET created_by = 'bob' WHERE stable_id = ?", (created.stable_id,))

        from fastapi_app.plugins.recent_documents.plugin import RecentDocumentsPlugin

        with mock.patch("fastapi_app.config.get_settings", return_value=files.settings), \
                mock.patch("fastapi_app.lib.core.dependencies.get_db", return_value=files.db):
            plugin = RecentDocumentsPlugin()
            plugin._seed_from_file_creators()
            asyncio.run(plugin._on_document_saved(stable_id="s1", doc_id="doc-b", username="alice"))
            asyncio.run(plugin._on_document_saved(stable_id="s2", doc_id="doc-b", username=None))

        data_dir = files.settings.plugins_data_dir
        self.assertEqual([sid for sid, _ in edit_store.get_user_edits("bob", data_dir)], [created.stable_id])
        self.assertEqual([sid for sid, _ in edit_store.get_user_edits("alice", data_dir)], ["s1"])


if __name__ == "__main__":
    unittest.main()
