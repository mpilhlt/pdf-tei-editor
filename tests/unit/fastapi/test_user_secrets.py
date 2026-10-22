"""
Unit tests for the encrypted per-user secret store, its REST endpoints, the missing-key
response of the extraction endpoint and the command line tool.

@testCovers fastapi_app/lib/secrets/store.py
@testCovers fastapi_app/lib/secrets/services.py
@testCovers fastapi_app/routers/secrets.py
@testCovers bin/user-secrets.py
"""

import importlib.util
import io
import os
import shutil
import sqlite3
import stat
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from fastapi_app.lib.core.dependencies import require_authenticated_user
from fastapi_app.lib.secrets import (
    ENCRYPTION_KEY_ENV_VAR,
    MissingSecretError,
    SecretServiceRegistry,
    SecretStore,
    SecretsError,
    get_secret_store,
    register_secret_service,
)
from fastapi_app.routers import secrets as secrets_router

SECRET = "sk-test-0123456789"


class TestSecretStore(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.env = patch.dict(os.environ)
        self.env.start()
        os.environ.pop(ENCRYPTION_KEY_ENV_VAR, None)

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.tmp)

    def test_roundtrip_per_user_and_service(self):
        store = SecretStore(self.tmp)
        store.set("alice", "anthropic", SECRET)
        store.set("bob", "anthropic", "other")
        self.assertEqual(store.get("alice", "anthropic"), SECRET)
        self.assertEqual(store.get("bob", "anthropic"), "other")
        self.assertIsNone(store.get("alice", "openai"))
        self.assertTrue(store.has("alice", "anthropic"))
        self.assertEqual(store.list_services("alice"), ["anthropic"])
        store.set("alice", "anthropic", "replaced")
        self.assertEqual(store.get("alice", "anthropic"), "replaced")
        self.assertTrue(store.delete("alice", "anthropic"))
        self.assertFalse(store.delete("alice", "anthropic"))
        self.assertIsNone(store.get("alice", "anthropic"))

    def test_delete_all_only_affects_the_user(self):
        store = SecretStore(self.tmp)
        store.set("alice", "anthropic", SECRET)
        store.set("alice", "openai", SECRET)
        store.set("bob", "anthropic", "other")
        self.assertEqual(store.delete_all("alice"), 2)
        self.assertEqual(store.list_services("alice"), [])
        self.assertEqual(store.get("bob", "anthropic"), "other")
        self.assertEqual(store.delete_all("alice"), 0)

    def test_value_is_encrypted_at_rest(self):
        store = SecretStore(self.tmp)
        store.set("alice", "anthropic", SECRET)
        stored = sqlite3.connect(store.db_path).execute("SELECT token FROM user_secrets").fetchone()[0]
        self.assertNotIn(SECRET, stored)
        self.assertNotIn(SECRET.encode(), (self.tmp / "secrets.db").read_bytes())

    def test_key_file_is_created_private_and_reused(self):
        SecretStore(self.tmp).set("alice", "s", SECRET)
        key_file = self.tmp / "secrets.key"
        self.assertEqual(stat.S_IMODE(key_file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.tmp / "secrets.db").stat().st_mode), 0o600)
        self.assertEqual(SecretStore(self.tmp).get("alice", "s"), SECRET)

    def test_key_file_fallback_logs_a_warning(self):
        with self.assertLogs("fastapi_app.lib.secrets.store", level="WARNING") as logs:
            SecretStore(self.tmp)
        self.assertTrue(any(ENCRYPTION_KEY_ENV_VAR in line for line in logs.output))

    def test_environment_key_takes_precedence(self):
        from cryptography.fernet import Fernet
        os.environ[ENCRYPTION_KEY_ENV_VAR] = Fernet.generate_key().decode()
        with self.assertNoLogs("fastapi_app.lib.secrets.store", level="WARNING"):
            SecretStore(self.tmp).set("alice", "s", SECRET)
        self.assertFalse((self.tmp / "secrets.key").exists())
        self.assertEqual(SecretStore(self.tmp).get("alice", "s"), SECRET)

    def test_wrong_key_raises_without_leaking(self):
        from cryptography.fernet import Fernet
        os.environ[ENCRYPTION_KEY_ENV_VAR] = Fernet.generate_key().decode()
        SecretStore(self.tmp).set("alice", "s", SECRET)
        os.environ[ENCRYPTION_KEY_ENV_VAR] = Fernet.generate_key().decode()
        with self.assertRaises(SecretsError) as ctx:
            SecretStore(self.tmp).get("alice", "s")
        self.assertNotIn(SECRET, str(ctx.exception))

    def test_invalid_environment_key(self):
        os.environ[ENCRYPTION_KEY_ENV_VAR] = "not a fernet key"
        with self.assertRaises(SecretsError):
            SecretStore(self.tmp)

    def test_empty_value_rejected(self):
        with self.assertRaises(ValueError):
            SecretStore(self.tmp).set("alice", "s", "")

    def test_require_user_secret(self):
        from fastapi_app.lib.secrets import require_user_secret
        store = SecretStore(self.tmp)
        with patch("fastapi_app.lib.secrets.store.get_secret_store", return_value=store):
            with self.assertRaises(MissingSecretError) as ctx:
                require_user_secret("alice", "anthropic")
            self.assertEqual(ctx.exception.service, "anthropic")
            with self.assertRaises(MissingSecretError):
                require_user_secret(None, "anthropic")
            store.set("alice", "anthropic", SECRET)
            self.assertEqual(require_user_secret("alice", "anthropic"), SECRET)


class TestSecretsRouter(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.env = patch.dict(os.environ)
        self.env.start()
        os.environ.pop(ENCRYPTION_KEY_ENV_VAR, None)
        SecretServiceRegistry.clear()
        register_secret_service("anthropic", "Anthropic Claude", "Billed to you", "https://console.anthropic.com/")
        self.store = SecretStore(self.tmp)
        self.user = {"username": "alice", "roles": ["user"]}
        app = FastAPI()
        app.include_router(secrets_router.router, prefix="/api/v1")
        app.dependency_overrides[require_authenticated_user] = lambda: self.user
        app.dependency_overrides[get_secret_store] = lambda: self.store
        self.client = TestClient(app)

    def tearDown(self):
        SecretServiceRegistry.clear()
        self.env.stop()
        shutil.rmtree(self.tmp)

    def test_list_set_delete_never_return_the_value(self):
        listed = self.client.get("/api/v1/secrets").json()
        self.assertEqual(listed, [{
            "id": "anthropic", "label": "Anthropic Claude", "description": "Billed to you",
            "help_url": "https://console.anthropic.com/", "is_set": False,
        }])
        response = self.client.put("/api/v1/secrets/anthropic", json={"value": f"  {SECRET} "})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(SECRET, response.text)
        self.assertTrue(response.json()["is_set"])
        self.assertEqual(self.store.get("alice", "anthropic"), SECRET)
        self.assertTrue(self.client.get("/api/v1/secrets").json()[0]["is_set"])
        self.assertFalse(self.client.delete("/api/v1/secrets/anthropic").json()["is_set"])
        self.assertIsNone(self.store.get("alice", "anthropic"))

    def test_other_users_do_not_see_the_key(self):
        self.store.set("bob", "anthropic", SECRET)
        self.assertFalse(self.client.get("/api/v1/secrets").json()[0]["is_set"])

    def test_delete_all_removes_only_own_keys(self):
        self.store.set("alice", "anthropic", SECRET)
        # a key for a service that is no longer registered is removed as well
        self.store.set("alice", "uninstalled", SECRET)
        self.store.set("bob", "anthropic", "other")
        self.store.set("bob", "uninstalled", "other")
        response = self.client.delete("/api/v1/secrets")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"removed": 2})
        self.assertEqual(self.store.list_services("alice"), [])
        self.assertEqual(self.store.list_services("bob"), ["anthropic", "uninstalled"])
        self.assertEqual(self.store.get("bob", "anthropic"), "other")
        self.assertFalse(self.client.get("/api/v1/secrets").json()[0]["is_set"])
        self.assertEqual(self.client.delete("/api/v1/secrets").json(), {"removed": 0})

    def test_unknown_service_and_empty_value(self):
        self.assertEqual(self.client.put("/api/v1/secrets/nope", json={"value": "x"}).status_code, 404)
        self.assertEqual(self.client.put("/api/v1/secrets/anthropic", json={"value": ""}).status_code, 422)
        self.assertEqual(self.client.put("/api/v1/secrets/anthropic", json={"value": "   "}).status_code, 400)


class TestExtractionMissingSecret(unittest.IsolatedAsyncioTestCase):
    async def test_missing_secret_becomes_428_with_service_info(self):
        from fastapi import HTTPException
        from fastapi_app.routers import extraction
        SecretServiceRegistry.clear()
        register_secret_service("anthropic", "Anthropic Claude", help_url="https://console.anthropic.com/")

        class Extractor:
            @classmethod
            def get_info(cls):
                return {"input": ["pdf"]}

            async def extract(self, **kwargs):
                raise MissingSecretError("anthropic", "alice")

        class Repo:
            def get_file_by_id_or_stable_id(self, _):
                class F:
                    file_type, id, doc_id, stable_id, doc_collections = "pdf", "abc123", "d", "s", []
                return F()

        tmp = Path(tempfile.mkdtemp())
        try:
            pdf = tmp / "files" / "ab" / "abc123.pdf"
            pdf.parent.mkdir(parents=True)
            pdf.write_bytes(b"%PDF")

            class Settings:
                data_root = tmp

            request = extraction.ExtractRequest(extractor="x", file_id="abc123", options={})
            http_request = type("R", (), {"base_url": "http://localhost/"})()
            with patch.object(extraction, "create_extractor", return_value=Extractor()), \
                 patch.object(extraction, "get_storage_path", return_value=pdf):
                with self.assertRaises(HTTPException) as ctx:
                    await extraction.extract_metadata(
                        request, http_request, Repo(), None, {"username": "alice"}, Settings()  # type: ignore[arg-type]
                    )
            self.assertEqual(ctx.exception.status_code, 428)
            self.assertEqual(ctx.exception.detail, {
                "code": "secret_required", "message": "Anthropic Claude needs your API key", "service": "anthropic",
                "label": "Anthropic Claude", "description": "", "help_url": "https://console.anthropic.com/",
            })
        finally:
            SecretServiceRegistry.clear()
            shutil.rmtree(tmp)


def _load_cli():
    path = Path(__file__).resolve().parents[3] / "bin" / "user-secrets.py"
    spec = importlib.util.spec_from_file_location("user_secrets_cli", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Capture(io.StringIO):
    def __init__(self, tty: bool = False):
        super().__init__()
        self._tty = tty

    def isatty(self) -> bool:
        return self._tty


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.env = patch.dict(os.environ)
        self.env.start()
        os.environ.pop(ENCRYPTION_KEY_ENV_VAR, None)
        self.cli = _load_cli()

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.tmp)

    def run_cli(self, *args: str, tty: bool = False, stdin: str | None = None, secret: str | None = None):
        out, err = _Capture(tty), io.StringIO()
        patches: list = [patch.object(sys, "stdout", out)]
        if stdin is not None:
            patches.append(patch.object(sys, "stdin", io.StringIO(stdin)))
        if secret is not None:
            patches.append(patch.object(self.cli.getpass, "getpass", return_value=secret))
        with redirect_stderr(err):
            for p in patches:
                p.start()
            try:
                code = self.cli.main(["--db-dir", str(self.tmp), "--user", "alice", *args])
            finally:
                for p in patches:
                    p.stop()
        return code, out.getvalue(), err.getvalue()

    def test_set_get_export_list_delete(self):
        code, out, err = self.run_cli("set", "anthropic", secret=SECRET)
        self.assertEqual(code, 0)
        self.assertNotIn(SECRET, out + err)
        self.assertEqual(self.run_cli("get", "anthropic")[1], SECRET)
        self.assertEqual(self.run_cli("export", "anthropic", "--env", "KEY")[1], f"export KEY={SECRET}\n")
        self.assertIn("anthropic", self.run_cli("list")[1])
        self.assertNotIn(SECRET, self.run_cli("list")[1])
        self.assertEqual(self.run_cli("delete", "anthropic")[0], 0)
        self.assertEqual(self.run_cli("get", "anthropic")[0], 1)

    def test_set_from_stdin(self):
        self.assertEqual(self.run_cli("set", "anthropic", "--stdin", stdin=SECRET + "\n")[0], 0)
        self.assertEqual(self.run_cli("get", "anthropic")[1], SECRET)

    def test_export_quotes_the_value(self):
        self.run_cli("set", "s", "--stdin", stdin="a b'c")
        self.assertEqual(self.run_cli("export", "s", "--env", "K")[1], "export K='a b'\"'\"'c'\n")

    def test_secret_is_never_printed_to_a_terminal(self):
        self.run_cli("set", "anthropic", secret=SECRET)
        for args in (("get", "anthropic"), ("export", "anthropic", "--env", "K")):
            code, out, err = self.run_cli(*args, tty=True)
            self.assertEqual(code, 1)
            self.assertNotIn(SECRET, out + err)

    def test_prompt_stores_a_missing_key_and_returns_it(self):
        self.assertEqual(self.run_cli("get", "anthropic")[0], 1)
        code, out, err = self.run_cli("get", "anthropic", "--prompt", secret=SECRET)
        self.assertEqual((code, out), (0, SECRET))
        self.assertNotIn(SECRET, err)
        self.assertEqual(self.run_cli("get", "anthropic")[1], SECRET)

    def test_user_is_required(self):
        with redirect_stderr(io.StringIO()), patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PTE_SECRETS_USER", None)
            self.assertEqual(self.cli.main(["--db-dir", str(self.tmp), "list"]), 1)


if __name__ == "__main__":
    unittest.main()
