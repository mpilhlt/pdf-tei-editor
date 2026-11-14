"""
Unit tests for bookmarks: the store, the REST endpoints (privacy, validation) and the garbage collection.

@testCovers fastapi_app/lib/bookmarks/store.py
@testCovers fastapi_app/routers/bookmarks.py
@testCovers fastapi_app/lib/models/models_bookmarks.py
@testCovers fastapi_app/lib/repository/doc_labels.py
"""

import gc
import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.config import get_settings
from fastapi_app.lib.bookmarks.store import BookmarkStore, collect_bookmark_garbage
from fastapi_app.lib.core.db_utils import close_all_connections
from fastapi_app.lib.core.dependencies import (
    get_file_repository,
    get_session_manager,
    get_sse_service,
    require_authenticated_user,
)
from fastapi_app.lib.core.gc_registry import GcContext
from fastapi_app.routers import bookmarks as bookmarks_router

ALICE = {"username": "alice", "roles": ["user", "annotator"], "groups": []}
BOB = {"username": "bob", "roles": ["user", "annotator"], "groups": []}
PATH = "/TEI/text/body/listBibl/bibl[2]"


class FakeFileRepo:
    """Returns the files of a dict; files with `hidden_from` are not readable by that user."""

    def __init__(self, files: dict[str, SimpleNamespace]):
        self.files = files

    def get_file_by_stable_id(self, stable_id: str, include_deleted: bool = False) -> SimpleNamespace | None:
        file = self.files.get(stable_id)
        if file is None or (file.deleted and not include_deleted):
            return None
        return file

    def get_pdf_for_document(self, doc_id: str) -> SimpleNamespace:
        return SimpleNamespace(doc_metadata={"title": f"Title of {doc_id}"}, label=None)


def tei_file(stable_id: str, doc_id: str = "doc1", deleted: bool = False, hidden_from: str | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        stable_id=stable_id, doc_id=doc_id, file_type="tei", deleted=deleted, label="Gold", hidden_from=hidden_from
    )


def fake_access(file: SimpleNamespace, user: dict, operation: str = "read") -> bool:
    return file.hidden_from != user["username"]


class TempDbTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db_dir = self.tmp / "db"
        self.db_dir.mkdir()
        (self.db_dir / "users.json").write_text(json.dumps([ALICE, BOB]))
        self.env = patch.dict(os.environ, {"DATA_ROOT": str(self.tmp)})
        self.env.start()
        get_settings.cache_clear()
        self.store = BookmarkStore(self.db_dir)

    def tearDown(self):
        self.env.stop()
        get_settings.cache_clear()
        close_all_connections()
        gc.collect()
        shutil.rmtree(self.tmp)


class TestBookmarkStore(TempDbTestCase):
    def test_add_list_rename_delete(self):
        first = self.store.add("alice", "s1", "doc1", PATH, "abcd1234", "bibl", "First", "Smith 2019")
        second = self.store.add("alice", "s2", "doc2", PATH, None, "bibl", "Second", None)
        self.store.add("bob", "s1", "doc1", PATH, None, "bibl", "Bob's", None)
        self.assertEqual({b.id for b in self.store.list("alice")}, {first.id, second.id})
        self.assertEqual([b.id for b in self.store.list("alice", "s1")], [first.id])
        renamed = self.store.rename("alice", first.id, "Renamed")
        assert renamed is not None
        self.assertEqual(renamed.title, "Renamed")
        self.assertIsNone(self.store.rename("bob", first.id, "Stolen"))
        self.assertFalse(self.store.delete("bob", first.id))
        self.assertTrue(self.store.delete("alice", first.id))
        self.assertEqual([b.id for b in self.store.list("alice")], [second.id])

    def test_gc_removes_bookmarks_of_purged_files_and_removed_users(self):
        self.store.add("alice", "kept", "doc1", PATH, None, "bibl", "Kept", None)
        self.store.add("alice", "soft-deleted", "doc1", PATH, None, "bibl", "Soft-deleted file", None)
        self.store.add("alice", "purged", "doc1", PATH, None, "bibl", "Purged file", None)
        self.store.add("carol", "kept", "doc1", PATH, None, "bibl", "Removed user", None)
        repo = FakeFileRepo({"kept": tei_file("kept"), "soft-deleted": tei_file("soft-deleted", deleted=True)})

        def context(dry_run: bool) -> GcContext:
            return GcContext(
                deleted_before=datetime.now(timezone.utc), file_repo=repo, file_storage=None,  # type: ignore[arg-type]
                db_dir=self.db_dir, dry_run=dry_run,
            )

        with patch("fastapi_app.lib.bookmarks.store.get_bookmark_store", lambda db_dir=None: self.store):
            dry = collect_bookmark_garbage(context(True))
            self.assertEqual(dry.items_deleted, 2)
            self.assertEqual(len(self.store.list("alice")) + len(self.store.list("carol")), 4)
            result = collect_bookmark_garbage(context(False))
        self.assertEqual(result.details, {"purged_file_bookmarks": 1, "removed_user_bookmarks": 1})
        self.assertEqual({b.title for b in self.store.list("alice")}, {"Kept", "Soft-deleted file"})
        self.assertEqual(self.store.list("carol"), [])


class TestBookmarksApi(TempDbTestCase):
    def setUp(self):
        super().setUp()
        self.user: dict[str, Any] = ALICE
        self.repo = FakeFileRepo({
            "s1": tei_file("s1"),
            "s2": tei_file("s2", doc_id="doc2", hidden_from="bob"),
            "pdf": SimpleNamespace(stable_id="pdf", doc_id="doc1", file_type="pdf", deleted=False, label=None, hidden_from=None),
        })
        self.events: list[tuple[str, str]] = []
        app = FastAPI()
        app.include_router(bookmarks_router.router)
        app.dependency_overrides[require_authenticated_user] = lambda: self.user
        app.dependency_overrides[bookmarks_router.get_store] = lambda: self.store
        app.dependency_overrides[get_file_repository] = lambda: self.repo
        app.dependency_overrides[get_sse_service] = lambda: None
        app.dependency_overrides[get_session_manager] = lambda: None
        self.client = TestClient(app)
        self.patches = [
            patch.object(bookmarks_router, "check_file_access", fake_access),
            patch.object(bookmarks_router, "send_to_user_sessions",
                         lambda sse, sessions, username, event, data: self.events.append((username, event)) or 0),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        super().tearDown()

    def create(self, **overrides: Any) -> Any:
        body = {"stable_id": "s1", "path": PATH, "fingerprint": "abcd1234", "element": "bibl", "title": "  Smith  ",
                "excerpt": "Smith 2019"}
        body.update(overrides)
        return self.client.post("/bookmarks", json=body)

    def test_create_and_list(self):
        response = self.create()
        self.assertEqual(response.status_code, 200, response.text)
        item = response.json()
        self.assertEqual(item["title"], "Smith")
        self.assertEqual(item["doc_label"], "Title of doc1, Gold")
        self.assertTrue(item["available"])
        self.assertEqual(self.events, [("alice", "bookmarksChanged")])
        items = self.client.get("/bookmarks").json()["items"]
        self.assertEqual([i["id"] for i in items], [item["id"]])
        self.assertEqual(self.client.get("/bookmarks", params={"stable_id": "s2"}).json()["items"], [])

    def test_bookmarks_are_private(self):
        item = self.create().json()
        self.user = BOB
        self.assertEqual(self.client.get("/bookmarks").json()["items"], [])
        self.assertEqual(self.client.patch(f"/bookmarks/{item['id']}", json={"title": "x"}).status_code, 404)
        self.assertEqual(self.client.delete(f"/bookmarks/{item['id']}").status_code, 404)
        self.user = ALICE
        self.assertEqual(len(self.client.get("/bookmarks").json()["items"]), 1)

    def test_only_elements_inside_the_text(self):
        for path in ["/TEI/teiHeader/fileDesc", "/TEI/text", "/TEI/standOff/listAnnotation", "TEI/text/body", "/TEI/text/body/../x"]:
            self.assertEqual(self.create(path=path).status_code, 400, path)
        self.assertEqual(self.create(path="/TEI/text/body").status_code, 200)
        self.assertEqual(self.create(path="/TEI/text/front/titlePage[2]/docTitle").status_code, 200)

    def test_rejects_unreadable_and_non_tei_files_and_empty_titles(self):
        self.assertEqual(self.create(stable_id="missing").status_code, 404)
        self.assertEqual(self.create(stable_id="pdf").status_code, 400)
        self.assertEqual(self.create(title="   ").status_code, 422)
        self.user = BOB
        self.assertEqual(self.create(stable_id="s2").status_code, 404)

    def test_rename_and_delete(self):
        item = self.create().json()
        renamed = self.client.patch(f"/bookmarks/{item['id']}", json={"title": "Doe"}).json()
        self.assertEqual(renamed["title"], "Doe")
        self.assertEqual(self.client.delete(f"/bookmarks/{item['id']}").json(), {"deleted": True})
        self.assertEqual(self.client.get("/bookmarks").json()["items"], [])

    def test_bookmark_of_a_deleted_file_is_unavailable(self):
        item = self.create().json()
        self.repo.files["s1"].deleted = True
        listed = self.client.get("/bookmarks").json()["items"]
        self.assertEqual(listed[0]["id"], item["id"])
        self.assertFalse(listed[0]["available"])


if __name__ == "__main__":
    unittest.main()
