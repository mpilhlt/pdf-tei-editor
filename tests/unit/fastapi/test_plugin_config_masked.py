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
from fastapi_app.lib.utils.config_utils import MASKED_SENTINEL, Config, get_config_value

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
        self.assertEqual(self.config.get(KEY), "secret")
        self.assertEqual(self.config.load(apply_masks=True)[KEY], MASKED_SENTINEL)

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


if __name__ == "__main__":
    unittest.main()
