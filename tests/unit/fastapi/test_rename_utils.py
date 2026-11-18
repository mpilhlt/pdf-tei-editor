"""
Unit tests for renaming the ids of users, projects and collections.

@testCovers fastapi_app/lib/utils/rename_utils.py
@testCovers fastapi_app/lib/repository/file_repository.py::rename_created_by
@testCovers fastapi_app/lib/repository/file_repository.py::rename_collection
"""

import gc
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from cryptography.fernet import Fernet

from fastapi_app.lib.bookmarks.store import BookmarkStore
from fastapi_app.lib.core.access_tokens import AccessTokenStore
from fastapi_app.lib.core.database import DatabaseManager
from fastapi_app.lib.core.sessions import SessionManager
from fastapi_app.lib.messages.store import MessageStore
from fastapi_app.lib.models.models import FileCreate, FileMetadata
from fastapi_app.lib.repository.file_repository import FileRepository
from fastapi_app.lib.repository.permissions_db import PermissionsDB, get_document_permissions, set_document_permissions
from fastapi_app.lib.secrets.encryption import ENCRYPTION_KEY_ENV_VAR
from fastapi_app.lib.secrets.store import SecretStore
from fastapi_app.lib.utils.data_utils import load_entity_data, save_entity_data
from fastapi_app.lib.utils.rename_utils import RenameError, rename_collection, rename_project, rename_user


class RenameTestCase(unittest.TestCase):

    def setUp(self) -> None:
        self.db_dir = Path(tempfile.mkdtemp())
        self.env = patch.dict(os.environ)
        self.env.start()
        os.environ[ENCRYPTION_KEY_ENV_VAR] = Fernet.generate_key().decode()
        self.db = DatabaseManager(self.db_dir / "metadata.db")
        self.repo = FileRepository(self.db)
        save_entity_data(self.db_dir, "users", [
            {"username": "alice", "fullname": "Alice", "roles": ["user"], "groups": []},
            {"username": "bob", "fullname": "Bob", "roles": ["user"], "groups": []},
        ])
        save_entity_data(self.db_dir, "projects", [
            {"id": "p1", "name": "P1", "members": ["alice", "bob"], "collections": ["c1", "c2"], "config": {"x": 1}},
            {"id": "p2", "name": "P2", "members": ["bob"], "collections": ["c2"]},
        ])
        save_entity_data(self.db_dir, "collections", [
            {"id": "c1", "name": "C1", "owner": "alice"},
            {"id": "c2", "name": "C2", "owner": "bob"},
        ])
        save_entity_data(self.db_dir, "groups", [{"id": "g1", "name": "G1", "collections": ["c1"]}])

    def tearDown(self) -> None:
        self.env.stop()
        gc.collect()
        shutil.rmtree(self.db_dir)

    def file(self, stable_id: str) -> FileMetadata:
        file = self.repo.get_file_by_stable_id(stable_id, include_deleted=True)
        assert file is not None
        return file

    def add_file(self, stable_id: str, created_by: str, collections: list[str]) -> None:
        self.repo.insert_file(FileCreate(
            id=stable_id.ljust(64, "0"), stable_id=stable_id, filename=f"{stable_id}.pdf", doc_id=stable_id,
            file_type="pdf", file_size=1, created_by=created_by, doc_collections=collections,
        ))


class TestRenameUser(RenameTestCase):

    def rename(self, old: str, new: str, permissions_db: PermissionsDB | None = None) -> dict[str, int]:
        with patch("fastapi_app.lib.core.access_tokens.get_access_token_store", return_value=self.tokens), \
             patch("fastapi_app.lib.secrets.store.get_secret_store", return_value=self.secrets):
            return rename_user(self.db_dir, old, new, self.repo, self.sessions, permissions_db)

    def setUp(self) -> None:
        super().setUp()
        self.sessions = SessionManager(self.db_dir)
        self.tokens = AccessTokenStore(self.db_dir)
        self.secrets = SecretStore(self.db_dir)

    def test_replaces_username_in_all_stores(self) -> None:
        self.add_file("f1", "alice", ["c1"])
        self.add_file("f2", "bob", ["c2"])
        session_id = self.sessions.create_session("alice")
        _, token = self.tokens.create("alice", "alice", "cli", None)
        self.secrets.set("alice", "kisski", "secret-value")
        bookmarks = BookmarkStore(self.db_dir)
        bookmarks.add("alice", "f1", "f1", "/TEI", None, "p", "Title", None)
        messages = MessageStore(self.db_dir)
        messages.add_direct_message("d:k1", "alice", "f1", "f1", "bob", "Bob", "hello")
        messages.set_read("alice", ["d:k1"], True)
        permissions_db = PermissionsDB(self.db_dir / "permissions.db")
        set_document_permissions("f1", "owner", "owner", "alice", permissions_db)

        changes = self.rename("alice", "carol", permissions_db)

        self.assertEqual([u["username"] for u in load_entity_data(self.db_dir, "users")], ["carol", "bob"])
        self.assertEqual(load_entity_data(self.db_dir, "projects")[0]["members"], ["carol", "bob"])
        self.assertEqual(load_entity_data(self.db_dir, "collections")[0]["owner"], "carol")
        self.assertEqual(self.file("f1").created_by, "carol")
        self.assertEqual(self.file("f2").created_by, "bob")
        self.assertEqual(self.sessions.get_username_by_session_id(session_id), "carol")
        stored_token = self.tokens.get(token["token_id"])
        assert stored_token is not None
        self.assertEqual((stored_token["username"], stored_token["created_by"]), ("carol", "carol"))
        self.assertEqual(self.secrets.get("carol", "kisski"), "secret-value")
        self.assertIsNone(self.secrets.get("alice", "kisski"))
        self.assertEqual(len(bookmarks.list("carol")), 1)
        self.assertEqual([m.key for m in messages.list_messages("carol")], ["d:k1"])
        self.assertTrue(messages.list_messages("carol")[0].read)
        permissions = get_document_permissions("f1", permissions_db)
        assert permissions is not None
        self.assertEqual(permissions.owner, "carol")
        self.assertEqual(changes["users"], 1)
        self.assertEqual(changes["files"], 1)
        self.assertEqual(changes["sessions"], 1)

    def test_refuses_unknown_invalid_and_taken_ids(self) -> None:
        cases = [("dave", "erin", 404), ("alice", "bob", 409), ("alice", "al ice", 400), ("alice", "alice", 400)]
        for old, new, status in cases:
            with self.subTest(old=old, new=new):
                with self.assertRaises(RenameError) as ctx:
                    self.rename(old, new)
                self.assertEqual(ctx.exception.status_code, status)
        self.assertEqual([u["username"] for u in load_entity_data(self.db_dir, "users")], ["alice", "bob"])


class TestRenameProject(RenameTestCase):

    def test_renames_project_and_default_project_config(self) -> None:
        config = MagicMock()
        config.get.return_value = "p1"
        config.set.return_value = (True, "")
        with patch("fastapi_app.lib.utils.rename_utils.get_config", return_value=config):
            changes = rename_project(self.db_dir, "p1", "project-one")

        projects = load_entity_data(self.db_dir, "projects")
        self.assertEqual([p["id"] for p in projects], ["project-one", "p2"])
        self.assertEqual(projects[0]["config"], {"x": 1})
        config.set.assert_called_once_with("rbac.default-project", "project-one")
        self.assertEqual(changes, {"projects": 1, "config": 1})

    def test_keeps_other_default_project(self) -> None:
        config = MagicMock()
        config.get.return_value = "p2"
        with patch("fastapi_app.lib.utils.rename_utils.get_config", return_value=config):
            rename_project(self.db_dir, "p1", "project-one")
        config.set.assert_not_called()

    def test_refuses_taken_id(self) -> None:
        with self.assertRaises(RenameError) as ctx:
            rename_project(self.db_dir, "p1", "p2")
        self.assertEqual(ctx.exception.status_code, 409)


class TestRenameCollection(RenameTestCase):

    def test_replaces_collection_id_everywhere(self) -> None:
        self.add_file("f1", "alice", ["c1"])
        self.add_file("f2", "alice", ["c1", "c2"])
        self.add_file("f3", "alice", ["c2"])
        self.add_file("f4", "alice", ["c1"])
        self.repo.delete_file("f4".ljust(64, "0"))

        changes = rename_collection(self.db_dir, "c1", "corpus", self.repo)

        self.assertEqual([c["id"] for c in load_entity_data(self.db_dir, "collections")], ["corpus", "c2"])
        self.assertEqual(load_entity_data(self.db_dir, "projects")[0]["collections"], ["corpus", "c2"])
        self.assertEqual(load_entity_data(self.db_dir, "groups")[0]["collections"], ["corpus"])
        self.assertEqual(self.file("f1").doc_collections, ["corpus"])
        self.assertEqual(self.file("f2").doc_collections, ["corpus", "c2"])
        self.assertEqual(self.file("f3").doc_collections, ["c2"])
        self.assertEqual(self.file("f4").doc_collections, ["corpus"])
        self.assertEqual(changes, {"collections": 1, "projects": 1, "groups": 1, "files": 3})

    def test_does_not_rename_collection_with_shared_prefix(self) -> None:
        save_entity_data(self.db_dir, "collections", [{"id": "c1", "name": "C1"}, {"id": "c10", "name": "C10"}])
        self.add_file("f1", "alice", ["c10"])
        rename_collection(self.db_dir, "c1", "corpus", self.repo)
        self.assertEqual(self.file("f1").doc_collections, ["c10"])

    def test_refuses_invalid_id(self) -> None:
        with self.assertRaises(RenameError) as ctx:
            rename_collection(self.db_dir, "c1", "a/b", self.repo)
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
