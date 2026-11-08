"""
Tests for password hashing and the password login.

@testCovers fastapi_app/lib/utils/password_hash.py
@testCovers fastapi_app/api/auth.py
"""

import gc
import hashlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.api import auth as auth_api
from fastapi_app.config import get_settings
from fastapi_app.lib.core.db_utils import close_all_connections
from fastapi_app.lib.core.login_rate_limit import login_rate_limiter
from fastapi_app.lib.utils.password_hash import (
    hash_password,
    is_legacy_hash,
    upgrade_legacy_hash,
    upgrade_stored_hashes,
    verify_password,
)


def sha256_hex(password: str) -> str:
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


class TestPasswordHash(unittest.TestCase):
    def test_hash_and_verify(self):
        stored = hash_password("secret")
        self.assertTrue(stored.startswith("scrypt$"))
        self.assertTrue(verify_password("secret", stored))
        self.assertFalse(verify_password("wrong", stored))

    def test_hash_is_salted(self):
        self.assertNotEqual(hash_password("secret"), hash_password("secret"))

    def test_hash_does_not_accept_the_stored_value_or_sha256(self):
        stored = hash_password("secret")
        self.assertFalse(verify_password(stored, stored))
        self.assertFalse(verify_password(sha256_hex("secret"), stored))

    def test_legacy_hash_verifies(self):
        legacy = sha256_hex("secret")
        self.assertTrue(is_legacy_hash(legacy))
        self.assertTrue(verify_password("secret", legacy))
        self.assertFalse(verify_password("wrong", legacy))
        # The legacy digest itself is no longer a password
        self.assertFalse(verify_password(legacy, legacy))

    def test_upgraded_legacy_hash_verifies_with_the_same_password(self):
        upgraded = upgrade_legacy_hash(sha256_hex("secret"))
        self.assertFalse(is_legacy_hash(upgraded))
        self.assertTrue(verify_password("secret", upgraded))
        self.assertFalse(verify_password("wrong", upgraded))

    def test_malformed_or_empty_hash_is_rejected(self):
        for stored in ["", "scrypt$1$2", "bcrypt$x$y$z$a$b", "scrypt$a$8$1$xx$yy", "plaintext"]:
            self.assertFalse(verify_password("secret", stored), stored)
        self.assertFalse(verify_password("", hash_password("secret")))


class TempUsersTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db_dir = self.tmp / "db"
        self.db_dir.mkdir()
        self.users_file = self.db_dir / "users.json"

    def tearDown(self):
        shutil.rmtree(self.tmp)


class TestUpgradeStoredHashes(TempUsersTestCase):
    def test_upgrades_only_legacy_hashes(self):
        current = hash_password("other")
        self.users_file.write_text(json.dumps([
            {"username": "old", "passwd_hash": sha256_hex("secret")},
            {"username": "new", "passwd_hash": current},
            {"username": "none"},
        ]))
        self.assertEqual(upgrade_stored_hashes(self.users_file), 1)
        users = {u["username"]: u for u in json.loads(self.users_file.read_text())}
        self.assertTrue(users["old"]["passwd_hash"].startswith("scrypt$"))
        self.assertTrue(verify_password("secret", users["old"]["passwd_hash"]))
        self.assertEqual(users["new"]["passwd_hash"], current)
        self.assertNotIn("passwd_hash", users["none"])
        self.assertEqual(upgrade_stored_hashes(self.users_file), 0)

    def test_missing_file(self):
        self.assertEqual(upgrade_stored_hashes(self.users_file), 0)


class TestPasswordLogin(TempUsersTestCase):
    def setUp(self):
        super().setUp()
        self.users_file.write_text(json.dumps([
            {"username": "alice", "roles": ["user"], "passwd_hash": hash_password("secret")},
            {"username": "bob", "roles": ["user"], "passwd_hash": sha256_hex("legacy")},
        ]))
        self.env = patch.dict(os.environ, {"DATA_ROOT": str(self.tmp)})
        self.env.start()
        get_settings.cache_clear()
        login_rate_limiter.clear()
        app = FastAPI()
        app.include_router(auth_api.router)
        self.client = TestClient(app)

    def tearDown(self):
        self.env.stop()
        get_settings.cache_clear()
        close_all_connections()
        gc.collect()
        super().tearDown()

    def test_login_with_password(self):
        response = self.client.post("/auth/login", json={"username": "alice", "password": "secret"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["sessionId"])

    def test_login_with_wrong_password(self):
        response = self.client.post("/auth/login", json={"username": "alice", "password": "wrong"})
        self.assertEqual(response.status_code, 401)

    def test_login_with_password_against_legacy_hash(self):
        response = self.client.post("/auth/login", json={"username": "bob", "password": "legacy"})
        self.assertEqual(response.status_code, 200)

    def test_password_hash_is_not_a_credential(self):
        for username, digest in [("alice", sha256_hex("secret")), ("bob", sha256_hex("legacy"))]:
            response = self.client.post("/auth/login", json={"username": username, "passwd_hash": digest})
            self.assertEqual(response.status_code, 400)
            self.assertIn("password", response.json()["detail"])
            response = self.client.post("/auth/login", json={"username": username, "password": digest})
            self.assertEqual(response.status_code, 401)

    def test_login_without_password(self):
        response = self.client.post("/auth/login", json={"username": "alice"})
        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
