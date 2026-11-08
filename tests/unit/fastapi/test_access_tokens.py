"""
Unit tests for personal access tokens: the token store, the permission rules, the REST endpoints,
token login, the session link and the cleanup on user removal.

@testCovers fastapi_app/lib/core/access_tokens.py
@testCovers fastapi_app/lib/permissions/access_token_permissions.py
@testCovers fastapi_app/routers/access_tokens.py
@testCovers fastapi_app/api/auth.py
@testCovers fastapi_app/lib/core/sessions.py
@testCovers fastapi_app/lib/core/login_rate_limit.py
@testCovers fastapi_app/lib/core/migrations/versions/m012_sessions_token_columns.py
"""

import gc
import json
import os
import shutil
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.api import auth as auth_api
from fastapi_app.config import get_settings
from fastapi_app.lib.core.access_tokens import (
    AccessTokenStore,
    get_access_token_store,
    parse_token,
    revoke_token,
    revoke_user_tokens,
)
from fastapi_app.lib.core.db_utils import close_all_connections
from fastapi_app.lib.core.dependencies import get_session_manager, require_authenticated_user
from fastapi_app.lib.core.gc_registry import GcContext
from fastapi_app.lib.core.login_rate_limit import login_rate_limiter
from fastapi_app.lib.core.sessions import SessionManager
from fastapi_app.lib.permissions.access_token_permissions import can_create_token_for, can_manage_token
from fastapi_app.lib.permissions.user_utils import remove_user
from fastapi_app.routers import access_tokens as tokens_router

ADMIN = {"username": "admin", "roles": ["admin"], "groups": []}
REVIEWER = {"username": "rev", "roles": ["user", "annotator", "reviewer"], "groups": []}
ANNOTATOR = {"username": "ann", "roles": ["user", "annotator"], "groups": []}
OTHER_REVIEWER = {"username": "rev2", "roles": ["user", "annotator", "reviewer"], "groups": []}
BACKUP_USER = {"username": "bak", "roles": ["user", "backup"], "groups": []}
WILDCARD = {"username": "root", "roles": ["*"], "groups": []}
USERS = [ADMIN, REVIEWER, ANNOTATOR, OTHER_REVIEWER, BACKUP_USER, WILDCARD]


class TempDbTestCase(unittest.TestCase):
    """Creates a data root with users.json and points the settings at it."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db_dir = self.tmp / "db"
        self.db_dir.mkdir()
        (self.db_dir / "users.json").write_text(json.dumps(USERS))
        self.env = patch.dict(os.environ, {"DATA_ROOT": str(self.tmp)})
        self.env.start()
        get_settings.cache_clear()
        login_rate_limiter.clear()

    def tearDown(self):
        self.env.stop()
        get_settings.cache_clear()
        close_all_connections()
        gc.collect()
        shutil.rmtree(self.tmp)


class TestAccessTokenStore(TempDbTestCase):
    def test_create_and_verify(self):
        store = AccessTokenStore(self.db_dir)
        token, info = store.create("rev", "admin", "CI", time.time() + 3600)
        self.assertTrue(token.startswith("pte_"))
        parsed = parse_token(token)
        assert parsed is not None
        self.assertEqual(parsed[0], info["token_id"])
        self.assertIsNone(info["last_used_at"])
        verified = store.verify(token)
        assert verified is not None
        self.assertEqual(verified["username"], "rev")
        self.assertEqual(verified["created_by"], "admin")
        self.assertIsNotNone(store.get(info["token_id"])["last_used_at"])  # type: ignore[index]

    def test_only_the_hash_is_stored(self):
        store = AccessTokenStore(self.db_dir)
        token, _ = store.create("rev", "rev", "CI", None)
        secret = token.split("_", 2)[2]
        conn = sqlite3.connect(self.db_dir / "access_tokens.db")
        dump = "\n".join(conn.iterdump())
        conn.close()
        self.assertNotIn(secret, dump)

    def test_rejects_unknown_wrong_revoked_and_expired_tokens(self):
        store = AccessTokenStore(self.db_dir)
        token, info = store.create("rev", "rev", "CI", time.time() + 3600)
        self.assertIsNone(store.verify("not-a-token"))
        self.assertIsNone(store.verify("pte_aaaaaaaa_secret"))
        self.assertIsNone(store.verify(token[:-2] + "xx"))
        expired_token, _ = store.create("rev", "rev", "old", time.time() - 1)
        self.assertIsNone(store.verify(expired_token))
        self.assertTrue(store.revoke(info["token_id"]))
        self.assertFalse(store.revoke(info["token_id"]))
        self.assertIsNone(store.verify(token))

    def test_list_filters(self):
        store = AccessTokenStore(self.db_dir)
        store.create("rev", "rev", "a", None)
        _, b = store.create("ann", "rev", "b", None)
        store.create("ann", "admin", "c", None)
        self.assertEqual(len(store.list_tokens()), 3)
        self.assertEqual({t["label"] for t in store.list_tokens(created_by="rev")}, {"a", "b"})
        self.assertEqual({t["label"] for t in store.list_tokens(username="ann")}, {"b", "c"})
        store.revoke(b["token_id"])
        self.assertEqual({t["label"] for t in store.list_tokens(username="ann")}, {"c"})
        self.assertEqual(len(store.list_tokens(include_revoked=True)), 3)

    def test_purge_removes_old_revoked_and_expired_tokens(self):
        store = AccessTokenStore(self.db_dir)
        _, keep = store.create("rev", "rev", "keep", time.time() + 3600)
        _, revoked = store.create("rev", "rev", "revoked", None)
        store.create("rev", "rev", "expired", time.time() - 10)
        store.revoke(revoked["token_id"])
        self.assertEqual(store.purge(time.time(), dry_run=True), 2)
        self.assertEqual(len(store.list_tokens(include_revoked=True)), 3)
        self.assertEqual(store.purge(time.time()), 2)
        self.assertEqual([t["token_id"] for t in store.list_tokens(include_revoked=True)], [keep["token_id"]])

    def test_gc_task_keeps_recently_expired_tokens(self):
        from fastapi_app.lib.core import gc_registry
        from fastapi_app.lib.core.access_tokens import register_access_token_gc_task

        store = AccessTokenStore(self.db_dir)
        store.create("rev", "rev", "recent", time.time() - 86400)
        store.create("rev", "rev", "old", time.time() - 40 * 86400)
        register_access_token_gc_task()
        task = next(t for t in gc_registry.list_gc_tasks() if t.id == "access-tokens")
        context = GcContext(
            deleted_before=None,  # type: ignore[arg-type]
            file_repo=None,  # type: ignore[arg-type]
            file_storage=None,  # type: ignore[arg-type]
            db_dir=self.db_dir,
        )
        self.assertEqual(task.task(context).items_deleted, 1)
        self.assertEqual([t["label"] for t in store.list_tokens()], ["recent"])

    def test_revoke_ends_token_sessions(self):
        store = AccessTokenStore(self.db_dir)
        sessions = SessionManager(self.db_dir)
        _, info = store.create("rev", "rev", "CI", None)
        token_session = sessions.create_session("rev", token_id=info["token_id"])
        password_session = sessions.create_session("rev")
        revoke_token(store, sessions, info["token_id"])
        self.assertIsNone(sessions.get_session(token_session))
        self.assertIsNotNone(sessions.get_session(password_session))

    def test_session_expires_with_token(self):
        sessions = SessionManager(self.db_dir)
        session_id = sessions.create_session("rev", token_id="abcdefgh", expires_at=time.time() - 1)
        self.assertFalse(sessions.is_session_valid(session_id, 3600))
        self.assertEqual(sessions.cleanup_expired_sessions(3600), 1)

    def test_removing_a_user_revokes_their_tokens(self):
        store = AccessTokenStore(self.db_dir)
        sessions = SessionManager(self.db_dir)
        _, info = store.create("ann", "rev", "CI", None)
        store.create("rev", "rev", "own", None)
        session_id = sessions.create_session("ann", token_id=info["token_id"])
        ok, message = remove_user(self.db_dir, "ann")
        self.assertTrue(ok)
        self.assertIn("Revoked 1 access token", message)
        self.assertEqual(store.list_tokens(username="ann"), [])
        self.assertEqual(len(store.list_tokens(username="rev")), 1)
        self.assertIsNone(sessions.get_session(session_id))
        self.assertEqual(revoke_user_tokens(self.db_dir, "ann"), 0)


class TestSessionsMigration(TempDbTestCase):
    def test_adds_columns_to_an_existing_sessions_table(self):
        from fastapi_app.lib.core.migration_runner import reset_migration_cache

        conn = sqlite3.connect(self.db_dir / "sessions.db")
        conn.execute(
            "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, username TEXT NOT NULL, created_at REAL NOT NULL, last_access REAL NOT NULL)"
        )
        conn.execute("INSERT INTO sessions VALUES ('s1', 'rev', 1.0, 1.0)")
        conn.commit()
        conn.close()
        reset_migration_cache()
        sessions = SessionManager(self.db_dir)
        session = sessions.get_session("s1")
        assert session is not None
        self.assertIsNone(session["token_id"])
        self.assertIsNone(session["expires_at"])
        sessions.create_session("rev", token_id="abcdefgh")


class TestPermissions(unittest.TestCase):
    def test_create_matrix(self):
        self.assertTrue(can_create_token_for(ADMIN, ANNOTATOR))
        self.assertTrue(can_create_token_for(ADMIN, WILDCARD))
        self.assertTrue(can_create_token_for(REVIEWER, REVIEWER))
        self.assertTrue(can_create_token_for(REVIEWER, ANNOTATOR))
        self.assertTrue(can_create_token_for(REVIEWER, OTHER_REVIEWER))
        self.assertFalse(can_create_token_for(REVIEWER, ADMIN))
        self.assertFalse(can_create_token_for(REVIEWER, WILDCARD))
        self.assertFalse(can_create_token_for(REVIEWER, BACKUP_USER))
        self.assertFalse(can_create_token_for(ANNOTATOR, ANNOTATOR))

    def test_manage_matrix(self):
        token: Any = {"token_id": "x", "username": "ann", "created_by": "rev"}
        self.assertTrue(can_manage_token(ADMIN, token))
        self.assertTrue(can_manage_token(REVIEWER, token))
        self.assertTrue(can_manage_token(ANNOTATOR, token))
        self.assertFalse(can_manage_token(OTHER_REVIEWER, token))


class TestAccessTokensApi(TempDbTestCase):
    def setUp(self):
        super().setUp()
        self.store = AccessTokenStore(self.db_dir)
        self.sessions = SessionManager(self.db_dir)
        self.user: dict[str, Any] = REVIEWER
        app = FastAPI()
        app.include_router(auth_api.router)
        app.include_router(tokens_router.router)
        app.dependency_overrides[require_authenticated_user] = lambda: self.user
        app.dependency_overrides[get_access_token_store] = lambda: self.store
        app.dependency_overrides[get_session_manager] = lambda: self.sessions
        self.client = TestClient(app)
        self.patches = [
            patch.object(auth_api, "get_session_manager", lambda: self.sessions),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        super().tearDown()

    def _create(self, **body: Any) -> Any:
        return self.client.post("/auth/tokens", json={"label": "CI", **body})

    def test_reviewer_creates_lists_and_revokes_own_token(self):
        response = self._create()
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertTrue(data["token"].startswith("pte_"))
        self.assertEqual(data["info"]["username"], "rev")
        self.assertAlmostEqual(data["info"]["expires_at"], time.time() + 90 * 86400, delta=60)

        listed = self.client.get("/auth/tokens").json()
        self.assertEqual([t["token_id"] for t in listed], [data["info"]["token_id"]])
        self.assertNotIn("token", listed[0])

        response = self.client.delete(f"/auth/tokens/{data['info']['token_id']}")
        self.assertEqual(response.json(), {"revoked": True})
        self.assertEqual(self.client.get("/auth/tokens").json(), [])

    def test_reviewer_cannot_create_token_for_admin(self):
        self.assertEqual(self._create(username="admin").status_code, 403)
        self.assertEqual(self._create(username="bak").status_code, 403)
        self.assertEqual(self._create(username="nobody").status_code, 404)
        self.assertEqual(self._create(username="ann").status_code, 200)

    def test_annotator_cannot_create_tokens_but_sees_own(self):
        self.store.create("ann", "rev", "for ann", None)
        self.store.create("rev", "rev", "for rev", None)
        self.user = ANNOTATOR
        self.assertEqual(self._create().status_code, 403)
        self.assertEqual(self.client.get("/auth/tokens/eligible-users").status_code, 403)
        self.assertEqual([t["label"] for t in self.client.get("/auth/tokens").json()], ["for ann"])

    def test_other_users_tokens_are_hidden(self):
        _, info = self.store.create("admin", "admin", "admin's", None)
        self.assertEqual(self.client.get("/auth/tokens").json(), [])
        self.assertEqual(self.client.delete(f"/auth/tokens/{info['token_id']}").status_code, 404)
        self.user = ADMIN
        self.assertEqual(len(self.client.get("/auth/tokens").json()), 1)

    def test_eligible_users(self):
        names = {u["username"] for u in self.client.get("/auth/tokens/eligible-users").json()}
        self.assertEqual(names, {"rev", "ann", "rev2"})
        self.user = ADMIN
        self.assertEqual(len(self.client.get("/auth/tokens/eligible-users").json()), len(USERS))

    def test_expiry_rules(self):
        config: dict[str, Any] = {"auth.access-tokens.max-days": 30, "auth.access-tokens.allow-no-expiry": False}

        class FakeConfig:
            def get(self, key: str, default: Any = None) -> Any:
                return config.get(key, default)

        with patch.object(tokens_router, "get_config", lambda: FakeConfig()):
            self.assertEqual(self._create(expires_in_days=31).status_code, 400)
            self.assertEqual(self._create(expires_in_days=30).status_code, 200)
            self.assertEqual(self._create(expires_in_days=None).status_code, 400)
            self.assertEqual(self._create(expires_in_days=0).status_code, 422)
            self.user = ADMIN
            self.assertEqual(self._create(expires_in_days=400).status_code, 200)
            self.assertEqual(self._create(expires_in_days=None).status_code, 400)
            config["auth.access-tokens.allow-no-expiry"] = True
            response = self._create(expires_in_days=None)
            self.assertEqual(response.status_code, 200)
            self.assertIsNone(response.json()["info"]["expires_at"])

    def test_token_login_returns_a_session_that_ends_with_revocation(self):
        token, info = self.store.create("rev", "admin", "CI", time.time() + 3600)
        response = self.client.post("/auth/token-login", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["username"], "rev")
        self.assertEqual(data["roles"], REVIEWER["roles"])
        session = self.sessions.get_session(data["sessionId"])
        assert session is not None
        self.assertEqual(session["token_id"], info["token_id"])
        self.assertEqual(session["expires_at"], info["expires_at"])
        self.assertTrue(self.sessions.is_session_valid(data["sessionId"], 3600))

        self.client.delete(f"/auth/tokens/{info['token_id']}")
        self.assertFalse(self.sessions.is_session_valid(data["sessionId"], 3600))
        response = self.client.post("/auth/token-login", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(response.status_code, 401)

    def test_token_login_accepts_the_token_in_the_body(self):
        token, _ = self.store.create("rev", "rev", "CI", None)
        response = self.client.post("/auth/token-login", json={"token": token})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["username"], "rev")

    def test_token_login_rejects_missing_and_bad_tokens(self):
        self.assertEqual(self.client.post("/auth/token-login").status_code, 401)
        self.assertEqual(self.client.post("/auth/token-login", headers={"Authorization": "Basic abc"}).status_code, 401)
        response = self.client.post("/auth/token-login", headers={"Authorization": "Bearer pte_aaaaaaaa_x"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.headers["WWW-Authenticate"], "Bearer")

    def test_token_login_is_rate_limited(self):
        token, _ = self.store.create("rev", "rev", "CI", None)
        for _ in range(10):
            self.client.post("/auth/token-login", headers={"Authorization": "Bearer pte_aaaaaaaa_x"})
        response = self.client.post("/auth/token-login", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(response.status_code, 429)
        self.assertIn("Retry-After", response.headers)

    def test_password_login_is_rate_limited_per_user(self):
        for _ in range(10):
            response = self.client.post("/auth/login", json={"username": "rev", "passwd_hash": "wrong"})
            self.assertEqual(response.status_code, 401)
        response = self.client.post("/auth/login", json={"username": "rev", "passwd_hash": "wrong"})
        self.assertEqual(response.status_code, 429)
        response = self.client.post("/auth/login", json={"username": "ann", "passwd_hash": "wrong"})
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
