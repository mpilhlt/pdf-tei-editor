"""
Unit tests for the edit history routes across all accessible projects (dashboard box and "See all" page).

@testCovers fastapi_app/plugins/edit_history/routes.py
"""

import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import (
    get_auth_manager,
    get_file_repository,
    get_file_storage,
    get_session_manager,
    require_authenticated_user,
)
from fastapi_app.plugins.dashboard.tests.fixtures import TempFileRepository
from fastapi_app.plugins.edit_history.routes import router

PROJECTS = [
    {"id": "p1", "name": "Mine", "members": ["alice"], "collections": ["c1"]},
    {"id": "p2", "name": "Not mine", "members": ["bob"], "collections": ["c2"]},
    {"id": "p3", "name": "Old", "members": ["alice"], "collections": ["c3"], "archived": True},
]


def _tei(*changes: tuple[str, str, str]) -> bytes:
    """TEI document with one `change` per (when, who, desc) tuple."""
    change_xml = "".join(
        f'<change when="{when}" who="#{who}" status="draft"><desc>{desc}</desc></change>' for when, who, desc in changes
    )
    return (
        '<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title>T</title>'
        '<respStmt><persName xml:id="alice">Alice A.</persName><resp>Annotator</resp></respStmt>'
        f"</titleStmt></fileDesc><revisionDesc>{change_xml}</revisionDesc></teiHeader></TEI>"
    ).encode("utf-8")


class TestAllProjectsHistory(unittest.TestCase):
    def setUp(self):
        self.files = TempFileRepository()
        self.addCleanup(self.files.cleanup)
        self.contents: dict[str, bytes] = {}
        storage = mock.MagicMock()
        storage.read_file.side_effect = lambda file_id, file_type: self.contents.get(file_id)
        patchers = [
            mock.patch("fastapi_app.config.get_settings", return_value=mock.MagicMock(db_dir=self.files.settings.db_dir, session_timeout=3600)),
            mock.patch("fastapi_app.lib.utils.project_utils.get_projects_with_details", return_value=PROJECTS),
        ]
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

        self.user = {"username": "alice", "roles": ["user"]}
        session_manager = mock.MagicMock()
        session_manager.is_session_valid.return_value = True
        auth_manager = mock.MagicMock()
        auth_manager.get_user_by_session_id.side_effect = lambda *args: self.user
        app = FastAPI()
        app.include_router(router)
        app.dependency_overrides[require_authenticated_user] = lambda: self.user
        app.dependency_overrides[get_file_repository] = lambda: self.files.repo
        app.dependency_overrides[get_file_storage] = lambda: storage
        app.dependency_overrides[get_session_manager] = lambda: session_manager
        app.dependency_overrides[get_auth_manager] = lambda: auth_manager
        self.client = TestClient(app)

    def _add(self, doc_id: str, collection: str, *changes: tuple[str, str, str]):
        tei = self.files.add(doc_id, collections=[collection], variant="v1", label=f"{doc_id} TEI")
        self.contents[tei.id] = _tei(*changes)
        return tei

    def _recent(self, limit: int = 10) -> list[dict]:
        response = self.client.get(f"/api/plugins/edit-history/recent?limit={limit}")
        self.assertEqual(response.status_code, 200)
        return response.json()["edits"]

    def _add_fixture_documents(self) -> None:
        self.files.add("doc-a", "pdf", ["c1"], label="Document A")
        self._add("doc-a", "c1", ("2026-10-01T10:00:00", "alice", "First"), ("2026-10-03T10:00:00", "alice", "Third"))
        self._add("doc-b", "c1", ("2026-10-02T10:00:00", "bob", "Second"))
        self._add("doc-c", "c2", ("2026-10-04T10:00:00", "bob", "Other project"))
        self._add("doc-d", "c3", ("2026-10-05T10:00:00", "bob", "Archived"))

    def test_recent_lists_changes_of_accessible_projects_newest_first(self):
        self._add_fixture_documents()

        edits = self._recent()

        self.assertEqual([e["description"] for e in edits], ["Third", "Second", "First"])
        self.assertEqual(edits[0]["who"], "Alice A.")
        self.assertEqual((edits[0]["title"], edits[0]["label"]), ("Document A", "doc-a TEI"))

    def test_admins_see_all_non_archived_projects(self):
        self.user = {"username": "admin", "roles": ["*"]}
        self._add_fixture_documents()

        self.assertEqual([e["description"] for e in self._recent()], ["Other project", "Third", "Second", "First"])

    def test_recent_limits_the_number_of_changes(self):
        self._add("doc-a", "c1", *[(f"2026-10-0{i}T10:00:00", "alice", f"Change {i}") for i in range(1, 6)])

        self.assertEqual([e["description"] for e in self._recent(limit=2)], ["Change 5", "Change 4"])

    def test_all_page_lists_every_change_of_accessible_projects(self):
        self._add_fixture_documents()

        response = self.client.get("/api/plugins/edit-history/all?session_id=s1")

        self.assertEqual(response.status_code, 200)
        for text in ["First", "Second", "Third"]:
            self.assertIn(text, response.text)
        self.assertNotIn("Other project", response.text)
        self.assertNotIn("Archived", response.text)


if __name__ == "__main__":
    unittest.main()
