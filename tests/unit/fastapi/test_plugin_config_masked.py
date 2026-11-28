"""
Unit tests for masked plugin settings (shared API keys).

@testCovers fastapi_app/lib/plugins/plugin_tools.py
@testCovers fastapi_app/lib/utils/config_utils.py
"""

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi_app.lib.plugins.plugin_tools import get_plugin_config
from fastapi_app.lib.secrets.encryption import ENCRYPTION_KEY_ENV_VAR, reset_fernet_cache
from fastapi_app.lib.utils.config_utils import Config, get_config_value

KEY = "plugin.test.api.key"
ENV = "PTE_TEST_SHARED_API_KEY"


class TestMaskedPluginConfig(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.config = Config(self.tmp)
        patcher = mock.patch("fastapi_app.lib.utils.config_utils.get_config", return_value=self.config)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.tmp)
        os.environ.pop(ENV, None)
        # Masked values are encrypted with a key file in the temporary directory, not the developer's key
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop(ENCRYPTION_KEY_ENV_VAR, None)
        reset_fernet_cache()

    def _register(self):
        return get_plugin_config(KEY, ENV, default=None, description="Shared key", masked=True)

    def test_unset_key_is_stored_empty_and_masked(self):
        self.assertIsNone(self._register())
        data = self.config.load()
        self.assertEqual(data[KEY], "")
        self.assertTrue(data[f"{KEY}.masked"])
        # Shown as not set, not as the "set but hidden" sentinel
        self.assertEqual(self.config.load(apply_masks=True)[KEY], "")
        self.assertEqual(get_config_value(KEY, self.tmp, apply_masks=True), "")

    def test_environment_variable_applies_after_an_empty_start(self):
        self._register()
        with mock.patch.dict(os.environ, {ENV: "secret"}):
            self.assertEqual(self._register(), "secret")
        # not copied into config.json, so that a later change of the variable applies too
        self.assertEqual(self.config.get(KEY), "")

    def test_value_set_in_the_editor_is_kept(self):
        self._register()
        self.config.set(KEY, "from-editor")
        with mock.patch.dict(os.environ, {ENV: "from-env"}):
            self.assertEqual(self._register(), "from-editor")

    def test_cleared_value_is_shown_as_not_set(self):
        self._register()
        self.config.set(KEY, "from-editor")
        self.config.set(KEY, "")
        self.assertEqual(self.config.load(apply_masks=True)[KEY], "")
        self.assertIsNone(self._register())

    def test_deleted_key_is_registered_again(self):
        self._register()
        self.config.set(KEY, "from-editor")
        self.config.delete(KEY, with_metadata=True)
        self.assertNotIn(KEY, self.config.load())
        self.assertIsNone(self._register())
        data = self.config.load()
        self.assertEqual(data[KEY], "")
        self.assertTrue(data[f"{KEY}.masked"])
        self.assertEqual(data[f"{KEY}.description"], "Shared key")


class TestEmptyPluginConfig(unittest.TestCase):
    """An empty stored value does not override the environment variable, a non-empty one does."""

    KEY = "plugin.test.languages"
    ENV = "PTE_TEST_LANGUAGES"

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.config = Config(self.tmp)
        patcher = mock.patch("fastapi_app.lib.utils.config_utils.get_config", return_value=self.config)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(shutil.rmtree, self.tmp)
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop(self.ENV, None)

    def _register(self, default: str = ""):
        return get_plugin_config(self.KEY, self.ENV, default=default, description="Languages")

    def test_empty_default_is_stored_and_env_applies_later(self):
        self.assertEqual(self._register(), "")
        self.assertEqual(self.config.get(self.KEY), "")
        with mock.patch.dict(os.environ, {self.ENV: "eng deu"}):
            self.assertEqual(self._register(), "eng deu")
        # still empty, so that changing or removing the variable applies too
        self.assertEqual(self.config.get(self.KEY), "")
        self.assertEqual(self._register(), "")

    def test_empty_env_falls_back_to_default(self):
        with mock.patch.dict(os.environ, {self.ENV: ""}):
            self.assertEqual(self._register(default="eng"), "eng")

    def test_non_empty_stored_value_overrides_env(self):
        self.config.set(self.KEY, "fra")
        with mock.patch.dict(os.environ, {self.ENV: "eng deu"}):
            self.assertEqual(self._register(), "fra")

    def test_env_value_of_a_new_key_is_stored(self):
        with mock.patch.dict(os.environ, {self.ENV: "eng"}):
            self.assertEqual(self._register(), "eng")
        self.assertEqual(self.config.get(self.KEY), "eng")
        self.assertEqual(self.config.get(f"{self.KEY}.description"), "Languages")


if __name__ == "__main__":
    unittest.main()
