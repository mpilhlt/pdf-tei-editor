"""
Unit tests for the encryption of masked config.json values at rest.

The tests remove SECRETS_ENCRYPTION_KEY from the environment and use a key file in a temporary
directory, so they do not depend on the developer's environment.

@testCovers fastapi_app/lib/utils/config_utils.py
@testCovers fastapi_app/lib/secrets/encryption.py
@testCovers bin/migrations/encrypt-masked-config-values.py
"""

import importlib.util
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from cryptography.fernet import Fernet

from fastapi_app.lib.plugins.plugin_tools import get_plugin_config
from fastapi_app.lib.secrets.encryption import ENCRYPTION_KEY_ENV_VAR, KEY_FILE_NAME, reset_fernet_cache
from fastapi_app.lib.utils.config_utils import (
    ENCRYPTED_PREFIX,
    MASKED_SENTINEL,
    Config,
    ConfigSecretError,
    check_config_secrets,
    get_config_value,
)

KEY = "plugin.test.api.key"
SECRET = "sk-test-0123456789"
REPO_ROOT = Path(__file__).resolve().parents[3]


def _load_migration():
    """Import the migration script, whose file name is not a valid module name."""
    path = REPO_ROOT / "bin" / "migrations" / "encrypt-masked-config-values.py"
    spec = importlib.util.spec_from_file_location("encrypt_masked_config_values", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _EncryptionTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop(ENCRYPTION_KEY_ENV_VAR, None)
        reset_fernet_cache()
        self.addCleanup(reset_fernet_cache)
        self.config = Config(self.tmp)

    def raw(self) -> dict[str, object]:
        return json.loads((self.tmp / "config.json").read_text())

    def write_raw(self, data: dict[str, object]) -> None:
        (self.tmp / "config.json").write_text(json.dumps(data))


class TestMaskedValueEncryption(_EncryptionTestCase):
    def test_masked_value_is_encrypted_at_rest_and_decrypted_on_read(self):
        success, message = self.config.set(KEY, SECRET, masked=True)
        self.assertTrue(success)
        self.assertNotIn(SECRET, message)
        self.assertNotIn(SECRET, (self.tmp / "config.json").read_text())
        self.assertTrue(self.raw()[KEY].startswith(ENCRYPTED_PREFIX))
        self.assertEqual(self.config.get(KEY), SECRET)
        self.assertEqual(self.raw()[f"{KEY}.type"], "string")
        self.assertTrue((self.tmp / KEY_FILE_NAME).exists())

    def test_non_masked_value_stays_plain_text(self):
        self.config.set("plugin.test.url", "https://example.org")
        self.assertEqual(self.raw()["plugin.test.url"], "https://example.org")
        self.assertFalse((self.tmp / KEY_FILE_NAME).exists())

    def test_empty_masked_value_is_not_encrypted(self):
        self.config.set(KEY, "", masked=True)
        self.assertEqual(self.raw()[KEY], "")
        self.assertFalse((self.tmp / KEY_FILE_NAME).exists())

    def test_later_changes_of_a_masked_key_are_encrypted(self):
        self.config.set(KEY, "", masked=True)
        self.config.set(KEY, SECRET)
        self.assertNotIn(SECRET, (self.tmp / "config.json").read_text())
        self.assertEqual(self.config.get(KEY), SECRET)

    def test_non_string_values_keep_their_type(self):
        self.config.set("plugin.test.port", 8080, masked=True)
        self.assertEqual(self.config.get("plugin.test.port"), 8080)

    def test_unchanged_value_keeps_its_token(self):
        self.config.set(KEY, SECRET, masked=True)
        token = self.raw()[KEY]
        self.config.set(KEY, SECRET, masked=True)
        self.assertEqual(self.raw()[KEY], token)
        self.config.set(KEY, "other")
        self.assertNotEqual(self.raw()[KEY], token)
        self.assertEqual(self.config.get(KEY), "other")

    def test_setting_the_masked_flag_encrypts_an_existing_value(self):
        self.config.set(KEY, SECRET)
        self.config.set(f"{KEY}.masked", True)
        self.assertNotIn(SECRET, (self.tmp / "config.json").read_text())
        self.assertEqual(self.config.get(KEY), SECRET)

    def test_removing_the_masked_flag_decrypts_the_value(self):
        self.config.set(KEY, SECRET, masked=True)
        self.config.set(f"{KEY}.masked", False)
        self.assertEqual(self.raw()[KEY], SECRET)

    def test_masks_and_load_do_not_decrypt(self):
        self.config.set(KEY, SECRET, masked=True)
        os.environ[ENCRYPTION_KEY_ENV_VAR] = Fernet.generate_key().decode()  # wrong key
        reset_fernet_cache()
        self.assertEqual(self.config.load(apply_masks=True)[KEY], MASKED_SENTINEL)
        self.assertEqual(get_config_value(KEY, self.tmp, apply_masks=True), MASKED_SENTINEL)
        self.assertTrue(self.config.load()[KEY].startswith(ENCRYPTED_PREFIX))

    def test_wrong_key_raises_without_leaking(self):
        self.config.set(KEY, SECRET, masked=True)
        os.environ[ENCRYPTION_KEY_ENV_VAR] = Fernet.generate_key().decode()
        reset_fernet_cache()
        with self.assertRaisesRegex(ConfigSecretError, "different key") as ctx:
            self.config.get(KEY)
        self.assertNotIn(SECRET, str(ctx.exception))

    def test_missing_key_file_raises_and_is_not_recreated(self):
        self.config.set(KEY, SECRET, masked=True)
        (self.tmp / KEY_FILE_NAME).unlink()
        reset_fernet_cache()
        with self.assertRaisesRegex(ConfigSecretError, "no encryption key"):
            self.config.get(KEY)
        self.assertFalse((self.tmp / KEY_FILE_NAME).exists())

    def test_environment_key_is_used(self):
        os.environ[ENCRYPTION_KEY_ENV_VAR] = Fernet.generate_key().decode()
        self.config.set(KEY, SECRET, masked=True)
        self.assertFalse((self.tmp / KEY_FILE_NAME).exists())
        self.assertEqual(self.config.get(KEY), SECRET)

    def test_same_key_as_the_secret_store(self):
        from fastapi_app.lib.secrets import SecretStore
        SecretStore(self.tmp).set("alice", "s", "user-secret")
        key = (self.tmp / KEY_FILE_NAME).read_text()
        self.config.set(KEY, SECRET, masked=True)
        self.assertEqual((self.tmp / KEY_FILE_NAME).read_text(), key)

    def test_plugin_config_reads_the_decrypted_value(self):
        with mock.patch("fastapi_app.lib.utils.config_utils.get_config", return_value=self.config):
            with mock.patch.dict(os.environ, {"PTE_TEST_KEY": SECRET}):
                self.assertEqual(get_plugin_config(KEY, "PTE_TEST_KEY", masked=True), SECRET)
            token = self.raw()[KEY]
            self.assertTrue(token.startswith(ENCRYPTED_PREFIX))
            # Re-registration on startup returns the secret and does not rewrite the token
            self.assertEqual(get_plugin_config(KEY, "PTE_TEST_KEY", masked=True), SECRET)
            self.assertEqual(self.raw()[KEY], token)


class TestCheckConfigSecrets(_EncryptionTestCase):
    def test_reports_encrypted_and_plain_text_values(self):
        self.config.set(KEY, SECRET, masked=True)
        self.write_raw({**self.raw(), "plugin.old.token": "plain", "plugin.old.token.masked": True})
        self.assertEqual(check_config_secrets(self.tmp), (1, ["plugin.old.token"]))

    def test_fails_with_a_clear_message_for_a_wrong_key(self):
        self.config.set(KEY, SECRET, masked=True)
        os.environ[ENCRYPTION_KEY_ENV_VAR] = Fernet.generate_key().decode()
        reset_fernet_cache()
        with self.assertRaises(ConfigSecretError) as ctx:
            check_config_secrets(self.tmp)
        self.assertIn(KEY, str(ctx.exception))
        self.assertIn(ENCRYPTION_KEY_ENV_VAR, str(ctx.exception))
        self.assertNotIn(SECRET, str(ctx.exception))

    def test_nothing_to_check(self):
        self.config.set("plugin.test.url", "x")
        self.assertEqual(check_config_secrets(self.tmp), (0, []))
        self.assertFalse((self.tmp / KEY_FILE_NAME).exists())


class TestMigration(_EncryptionTestCase):
    def setUp(self):
        super().setUp()
        self.migration = _load_migration()

    def run_migration(self, *args: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = self.migration.main(["--db-dir", str(self.tmp), *args])
        return code, out.getvalue(), err.getvalue()

    def test_encrypts_plain_text_masked_values(self):
        self.write_raw({KEY: SECRET, f"{KEY}.masked": True, f"{KEY}.type": "string", "plugin.test.url": "u", "plugin.test.empty": "", "plugin.test.empty.masked": True})
        code, out, _ = self.run_migration()
        self.assertEqual(code, 0)
        self.assertIn(f"Encrypted {KEY}", out)
        raw = self.raw()
        self.assertTrue(raw[KEY].startswith(ENCRYPTED_PREFIX))
        self.assertEqual(raw["plugin.test.url"], "u")
        self.assertEqual(raw["plugin.test.empty"], "")
        self.assertEqual(self.config.get(KEY), SECRET)
        # Idempotent
        code, out, _ = self.run_migration()
        self.assertEqual(code, 0)
        self.assertIn("No plain-text", out)

    def test_dry_run_changes_nothing(self):
        self.write_raw({KEY: SECRET, f"{KEY}.masked": True})
        code, out, _ = self.run_migration("--dry-run")
        self.assertEqual(code, 0)
        self.assertIn(f"Would encrypt {KEY}", out)
        self.assertEqual(self.raw()[KEY], SECRET)

    def test_rejects_malformed_config(self):
        (self.tmp / "config.json").write_text("{not json")
        code, _, err = self.run_migration()
        self.assertEqual(code, 1)
        self.assertIn("not valid JSON", err)
        self.assertEqual((self.tmp / "config.json").read_text(), "{not json")

    def test_rejects_values_encrypted_with_another_key(self):
        self.config.set(KEY, SECRET, masked=True)
        self.write_raw({**self.raw(), "plugin.old.token": "plain", "plugin.old.token.masked": True})
        os.environ[ENCRYPTION_KEY_ENV_VAR] = Fernet.generate_key().decode()
        reset_fernet_cache()
        code, _, err = self.run_migration()
        self.assertEqual(code, 1)
        self.assertIn("cannot be decrypted", err)
        self.assertEqual(self.raw()["plugin.old.token"], "plain")


if __name__ == "__main__":
    unittest.main()
